// Orchestrates concurrency-evidence runs (issue #5, extended by issue #11,
// #17, and #25): seeds seat(s), then fires N concurrent-request runs
// against them via k6, resetting between runs through the real HTTP
// DELETE /bookings/{id} endpoint (issue #8) rather than raw SQL or
// reseeding — the harness exercises the same API surface it's evidencing.
//
// Four load patterns, selected via --pattern:
//   hammer-seat (default): all CONCURRENCY requests race one seat
//     (hammer-seat.k6.js) — the existing double-booking/correctness evidence.
//   spread-seats: one VU per seat across CONCURRENCY distinct, pre-seeded
//     seats (spread-across-seats.k6.js) — zero conflicts ever fire, so this
//     establishes each mechanism's raw per-request overhead (issue #17).
//   deadlock-pairs: CONCURRENCY disjoint 2-seat pairs, both orderings of
//     each pair fired concurrently (deadlock-pairs.k6.js) — the adversarial
//     deadlock harness (issue #25); deadlock rate reads off the same
//     X-Booking-Retries/retry_exhausted tally the other two patterns report.
//   isolation: a CONCURRENCY-request hot-seat burst and a CONCURRENCY-seat
//     background stream fired concurrently in one k6 invocation
//     (cross-seat-isolation.k6.js) — measures whether contention on the hot
//     seat degrades unrelated seats' latency/throughput (issue #33,
//     Phase 4). --background-only drops the hot-seat stream, producing the
//     matched no-contention baseline. Each stream's metrics are reported
//     separately, not merged.
//
// Usage: tsx load-harness/run.ts [--concurrency 1000] [--repeat 2] [--base-url http://localhost:3000] [--pattern hammer-seat|spread-seats|deadlock-pairs|isolation] [--background-only]
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { pool } from "../src/db/pool.js";

type Pattern = "hammer-seat" | "spread-seats" | "deadlock-pairs" | "isolation";

interface Args {
  // hammer-seat: number of concurrent requests racing the one target seat.
  // spread-seats: number of distinct seats seeded, one VU each.
  // deadlock-pairs: number of disjoint 2-seat pairs seeded (2x seats, 2x VUs).
  // isolation: both the hot-seat burst size and the background stream's
  // distinct-seat count (see --background-only below).
  concurrency: number;
  baseUrl: string;
  repeat: number;
  pattern: Pattern;
  // isolation only: drop the hot-seat stream, seeding/firing only the
  // background stream — the matched no-contention baseline used to compute
  // degradation. Ignored by every other pattern.
  backgroundOnly: boolean;
}

function parsePositiveInt(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

function parsePattern(value: string | undefined): Pattern {
  if (value !== "hammer-seat" && value !== "spread-seats" && value !== "deadlock-pairs" && value !== "isolation") {
    throw new Error(
      `--pattern must be "hammer-seat", "spread-seats", "deadlock-pairs", or "isolation", got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    concurrency: 1000,
    baseUrl: "http://localhost:3000",
    repeat: 1,
    pattern: "hammer-seat",
    backgroundOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--concurrency") args.concurrency = parsePositiveInt("--concurrency", argv[++i]);
    if (argv[i] === "--base-url") args.baseUrl = String(argv[++i]);
    if (argv[i] === "--repeat") args.repeat = parsePositiveInt("--repeat", argv[++i]);
    if (argv[i] === "--pattern") args.pattern = parsePattern(argv[++i]);
    if (argv[i] === "--background-only") args.backgroundOnly = true;
  }
  return args;
}

async function seedTargetSeat(): Promise<{ eventId: string; seatId: string }> {
  const eventRes = await pool.query<{ id: string }>(
    "INSERT INTO events (name) VALUES ($1) RETURNING id",
    ["Load Harness: Hammer One Seat"],
  );
  const eventId = eventRes.rows[0]!.id;
  const seatRes = await pool.query<{ id: string }>(
    "INSERT INTO seats (event_id, label) VALUES ($1, 'A1') RETURNING id",
    [eventId],
  );
  return { eventId, seatId: seatRes.rows[0]!.id };
}

// Seeds N distinct seats under one event for the spread-seats pattern
// (issue #17) — bulk-inserted via generate_series rather than N sequential
// round-trips, since N here can be in the thousands.
async function seedSpreadSeats(n: number): Promise<{ eventId: string; seatIds: string[] }> {
  const eventRes = await pool.query<{ id: string }>(
    "INSERT INTO events (name) VALUES ($1) RETURNING id",
    ["Load Harness: Spread Across Seats"],
  );
  const eventId = eventRes.rows[0]!.id;
  const seatsRes = await pool.query<{ id: string }>(
    `INSERT INTO seats (event_id, label)
     SELECT $1, 'S' || gs FROM generate_series(1, $2) AS gs
     RETURNING id`,
    [eventId, n],
  );
  return { eventId, seatIds: seatsRes.rows.map((row) => row.id) };
}

// Seeds N disjoint 2-seat pairs under one event for the deadlock-pairs
// pattern (issue #25) — bulk-inserted via generate_series like
// seedSpreadSeats, then chunked into consecutive pairs. Which two ids land
// in the same pair doesn't matter for correctness, only that every id is
// distinct and appears in exactly one pair — both guaranteed by RETURNING
// on a single INSERT of n*2 freshly-generated rows, regardless of what
// order those rows come back in.
async function seedDeadlockPairs(n: number): Promise<{ eventId: string; pairs: [string, string][] }> {
  const eventRes = await pool.query<{ id: string }>(
    "INSERT INTO events (name) VALUES ($1) RETURNING id",
    ["Load Harness: Deadlock Pairs"],
  );
  const eventId = eventRes.rows[0]!.id;
  const seatsRes = await pool.query<{ id: string }>(
    `INSERT INTO seats (event_id, label)
     SELECT $1, 'D' || gs FROM generate_series(1, $2) AS gs
     RETURNING id`,
    [eventId, n * 2],
  );
  const seatIds = seatsRes.rows.map((row) => row.id);
  const pairs: [string, string][] = [];
  for (let i = 0; i < seatIds.length; i += 2) {
    pairs.push([seatIds[i]!, seatIds[i + 1]!]);
  }
  return { eventId, pairs };
}

interface K6Summary {
  // k6's --summary-export stores each metric's fields (count, rate, avg,
  // med, "p(99)", ...) directly on the metric object, not nested under a
  // `.values` key. A Counter that never received a single .add() call in
  // the run (e.g. zero conflicts) is omitted from `metrics` entirely, hence
  // the fallback to 0 in metricCount/metricStat.
  metrics: Record<string, Record<string, number>>;
}

function metricCount(summary: K6Summary, name: string): number {
  return summary.metrics[name]?.count ?? 0;
}

// Reads a Trend stat (e.g. "med" for p50, "p(99)") or Counter's "rate" off
// a k6 summary metric — both are issue #18 additions for Exhibit C's
// throughput/latency columns.
function metricStat(summary: K6Summary, name: string, field: string): number {
  return summary.metrics[name]?.[field] ?? 0;
}

// Shared by every pattern that seeds more than one seat and needs to know
// how many distinct bookings actually claimed each one (spread-seats,
// deadlock-pairs, isolation's background stream) — ground truth read
// straight from booking_seats rows, not from HTTP responses.
function tallyPerSeatWinners(
  rows: { seat_id: string }[],
): { winnersPerSeat: Map<string, number>; seatsDoubleBooked: number } {
  const winnersPerSeat = new Map<string, number>();
  for (const row of rows) {
    winnersPerSeat.set(row.seat_id, (winnersPerSeat.get(row.seat_id) ?? 0) + 1);
  }
  const seatsDoubleBooked = [...winnersPerSeat.values()].filter((count) => count > 1).length;
  return { winnersPerSeat, seatsDoubleBooked };
}

interface HttpStatusTally {
  201: number;
  409: number;
  // retry_exhausted (ADR-0012), tallied separately from `other` so
  // Exhibit C can report retry-exhaustion rate as its own column.
  503: number;
  other: number;
}

interface LatencyStats {
  p50Ms: number;
  p99Ms: number;
}

interface RunReport {
  attempt: number;
  ranAt: string;
  durationMs: number;
  httpStatusTally: HttpStatusTally;
  // Sum of X-Booking-Retries (ADR-0012) across every response in the run.
  retriesTotal: number;
  latency: LatencyStats;
  throughputRps: number;
  winningBookingIds: string[];
  winningUserIds: string[];
  winningBookingCount: number;
  doubleBooked: boolean;
}

async function runOnce(args: Args, seatId: string, attempt: number): Promise<RunReport> {
  const runId = randomUUID();
  const scriptPath = fileURLToPath(new URL("./hammer-seat.k6.js", import.meta.url));
  const summaryPath = fileURLToPath(new URL(`../docs/evidence/.k6-summary-${runId}.json`, import.meta.url));
  await mkdir(new URL("../docs/evidence/", import.meta.url), { recursive: true });

  console.log(`Firing ${args.concurrency} concurrent POST /bookings at seat ${seatId} via k6...`);
  const startedAt = new Date();
  const k6Result = spawnSync(
    "k6",
    ["run", `--summary-export=${summaryPath}`, scriptPath],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BASE_URL: args.baseUrl,
        SEAT_ID: seatId,
        RUN_ID: runId,
        CONCURRENCY: String(args.concurrency),
      },
    },
  );
  const finishedAt = new Date();

  if (k6Result.error) {
    throw new Error(
      `Failed to run k6 (is it installed? \`brew install k6\`): ${k6Result.error.message}`,
    );
  }
  if (k6Result.status !== 0) {
    throw new Error(`k6 exited with status ${k6Result.status}`);
  }

  const summary: K6Summary = JSON.parse(await readFile(summaryPath, "utf8"));
  await rm(summaryPath);

  // Ground truth: how many distinct bookings actually claimed this seat,
  // read straight from booking_seats rather than trusting HTTP responses.
  const { rows: winningBookings } = await pool.query<{ booking_id: string; user_id: string }>(
    `SELECT bs.booking_id, b.user_id
     FROM booking_seats bs
     JOIN bookings b ON b.id = bs.booking_id
     WHERE bs.seat_id = $1`,
    [seatId],
  );

  const report: RunReport = {
    attempt,
    ranAt: startedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    httpStatusTally: {
      201: metricCount(summary, "booking_created"),
      409: metricCount(summary, "booking_conflict"),
      503: metricCount(summary, "booking_retry_exhausted"),
      other: metricCount(summary, "booking_other_status"),
    },
    retriesTotal: metricCount(summary, "booking_retries"),
    latency: {
      p50Ms: metricStat(summary, "http_req_duration", "med"),
      p99Ms: metricStat(summary, "http_req_duration", "p(99)"),
    },
    throughputRps: metricStat(summary, "http_reqs", "rate"),
    winningBookingIds: winningBookings.map((r) => r.booking_id),
    winningUserIds: winningBookings.map((r) => r.user_id),
    winningBookingCount: winningBookings.length,
    doubleBooked: winningBookings.length > 1,
  };

  console.log(JSON.stringify(report, null, 2));
  if (report.doubleBooked) {
    console.error(
      `\n*** DOUBLE-BOOKING CONFIRMED: seat ${seatId} was won by ${winningBookings.length} concurrent requests. ***`,
    );
  } else {
    console.log(`\nSeat ${seatId} had exactly ${winningBookings.length} winner(s).`);
  }

  return report;
}

// Resets seat(s) via the real HTTP API (issue #8's DELETE /bookings/{id}),
// not raw SQL and not reseeding — this run's winning booking(s) are canceled
// so the next repeat starts from genuinely 'available' seats, exercising the
// same cancellation path a real client would use. Fired in capped-concurrency
// batches rather than one at a time — the hammer-seat pattern only ever
// passes 0-1 ids, but spread-seats (issue #17) can pass one per seeded seat,
// and unbounded Promise.all risks opening thousands of sockets at once.
const RESET_BATCH_SIZE = 50;

async function resetSeatViaApi(baseUrl: string, bookingIds: string[]): Promise<void> {
  for (let i = 0; i < bookingIds.length; i += RESET_BATCH_SIZE) {
    const batch = bookingIds.slice(i, i + RESET_BATCH_SIZE);
    await Promise.all(
      batch.map(async (bookingId) => {
        const res = await fetch(`${baseUrl}/bookings/${bookingId}`, { method: "DELETE" });
        if (res.status !== 204) {
          throw new Error(`Failed to reset seat: DELETE /bookings/${bookingId} returned ${res.status}`);
        }
      }),
    );
  }
}

async function main() {
  try {
    await run();
  } finally {
    // Postgres pool sockets stay open (and keep the process alive) until
    // explicitly closed — must run on the error path too, or a thrown error
    // (e.g. k6 missing, non-zero exit) leaves the process hanging instead of
    // exiting with the code set below.
    await pool.end();
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.pattern === "spread-seats") {
    await runSpreadPattern(args);
  } else if (args.pattern === "deadlock-pairs") {
    await runDeadlockPairsPattern(args);
  } else if (args.pattern === "isolation") {
    await runIsolationPattern(args);
  } else {
    await runHammerPattern(args);
  }
}

async function runHammerPattern(args: Args) {
  const strategy = process.env.BOOKING_STRATEGY ?? "naive";

  console.log("Seeding target seat...");
  const { eventId, seatId } = await seedTargetSeat();

  const runs: RunReport[] = [];
  try {
    for (let attempt = 1; attempt <= args.repeat; attempt += 1) {
      console.log(`\n=== Run ${attempt}/${args.repeat} (strategy=${strategy}) ===`);
      const report = await runOnce(args, seatId, attempt);
      runs.push(report);

      if (attempt < args.repeat && report.winningBookingIds.length > 0) {
        console.log(`Resetting seat ${seatId} via DELETE /bookings/{id} before the next run...`);
        await resetSeatViaApi(args.baseUrl, report.winningBookingIds);
      }
    }
  } finally {
    // Write whatever repeats completed even if a later one throws (e.g. k6
    // exits non-zero, or the reset DELETE fails) — already-verified repeats
    // shouldn't be lost just because a later one didn't finish.
    if (runs.length > 0) {
      const combined = {
        strategy,
        pattern: args.pattern,
        concurrency: args.concurrency,
        eventId,
        seatId,
        runs,
        anyDoubleBooked: runs.some((r) => r.doubleBooked),
      };

      const outPath = new URL(
        `../docs/evidence/${strategy}-load-run-${runs[0]!.ranAt.replace(/[:.]/g, "-")}.json`,
        import.meta.url,
      );
      await writeFile(outPath, JSON.stringify(combined, null, 2));
      console.log(`\nReport written to ${outPath.pathname}`);

      if (combined.anyDoubleBooked) {
        process.exitCode = 1;
      }
    }
  }
}

interface SpreadRunReport {
  attempt: number;
  ranAt: string;
  durationMs: number;
  httpStatusTally: HttpStatusTally;
  // Sum of X-Booking-Retries (ADR-0012) across every response in the run.
  retriesTotal: number;
  latency: LatencyStats;
  throughputRps: number;
  seatCount: number;
  seatsWithWinner: number;
  seatsDoubleBooked: number;
  winningBookingIds: string[];
  anyDoubleBooked: boolean;
}

async function runSpreadSeatsOnce(args: Args, seatIds: string[], attempt: number): Promise<SpreadRunReport> {
  const runId = randomUUID();
  const scriptPath = fileURLToPath(new URL("./spread-across-seats.k6.js", import.meta.url));
  const summaryPath = fileURLToPath(new URL(`../docs/evidence/.k6-summary-${runId}.json`, import.meta.url));
  await mkdir(new URL("../docs/evidence/", import.meta.url), { recursive: true });

  console.log(`Firing 1 concurrent POST /bookings at each of ${seatIds.length} seats via k6...`);
  const startedAt = new Date();
  const k6Result = spawnSync(
    "k6",
    ["run", `--summary-export=${summaryPath}`, scriptPath],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BASE_URL: args.baseUrl,
        RUN_ID: runId,
        SEAT_IDS: JSON.stringify(seatIds),
      },
    },
  );
  const finishedAt = new Date();

  if (k6Result.error) {
    throw new Error(
      `Failed to run k6 (is it installed? \`brew install k6\`): ${k6Result.error.message}`,
    );
  }
  if (k6Result.status !== 0) {
    throw new Error(`k6 exited with status ${k6Result.status}`);
  }

  const summary: K6Summary = JSON.parse(await readFile(summaryPath, "utf8"));
  await rm(summaryPath);

  // Ground truth: how many distinct bookings actually claimed each seeded
  // seat, read straight from booking_seats rather than trusting HTTP
  // responses.
  const { rows: winningBookings } = await pool.query<{ seat_id: string; booking_id: string }>(
    `SELECT bs.seat_id, bs.booking_id FROM booking_seats bs WHERE bs.seat_id = ANY($1)`,
    [seatIds],
  );

  const { winnersPerSeat, seatsDoubleBooked } = tallyPerSeatWinners(winningBookings);

  const report: SpreadRunReport = {
    attempt,
    ranAt: startedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    httpStatusTally: {
      201: metricCount(summary, "booking_created"),
      409: metricCount(summary, "booking_conflict"),
      503: metricCount(summary, "booking_retry_exhausted"),
      other: metricCount(summary, "booking_other_status"),
    },
    retriesTotal: metricCount(summary, "booking_retries"),
    latency: {
      p50Ms: metricStat(summary, "http_req_duration", "med"),
      p99Ms: metricStat(summary, "http_req_duration", "p(99)"),
    },
    throughputRps: metricStat(summary, "http_reqs", "rate"),
    seatCount: seatIds.length,
    seatsWithWinner: winnersPerSeat.size,
    seatsDoubleBooked,
    winningBookingIds: winningBookings.map((r) => r.booking_id),
    anyDoubleBooked: seatsDoubleBooked > 0,
  };

  console.log(JSON.stringify(report, null, 2));
  if (report.anyDoubleBooked) {
    console.error(
      `\n*** DOUBLE-BOOKING CONFIRMED: ${seatsDoubleBooked} seat(s) had more than one winner. ***`,
    );
  } else {
    console.log(`\nAll ${report.seatsWithWinner}/${seatIds.length} seats had exactly one winner, 0 conflicts.`);
  }

  return report;
}

async function runSpreadPattern(args: Args) {
  const strategy = process.env.BOOKING_STRATEGY ?? "naive";

  console.log(`Seeding ${args.concurrency} distinct seats...`);
  const { eventId, seatIds } = await seedSpreadSeats(args.concurrency);

  const runs: SpreadRunReport[] = [];
  try {
    for (let attempt = 1; attempt <= args.repeat; attempt += 1) {
      console.log(`\n=== Run ${attempt}/${args.repeat} (strategy=${strategy}, pattern=spread-seats) ===`);
      const report = await runSpreadSeatsOnce(args, seatIds, attempt);
      runs.push(report);

      if (attempt < args.repeat && report.winningBookingIds.length > 0) {
        console.log(`Resetting ${report.winningBookingIds.length} seat(s) via DELETE /bookings/{id} before the next run...`);
        await resetSeatViaApi(args.baseUrl, report.winningBookingIds);
      }
    }
  } finally {
    // Write whatever repeats completed even if a later one throws — mirrors
    // runHammerPattern's already-verified-repeats-shouldn't-be-lost handling.
    if (runs.length > 0) {
      const combined = {
        strategy,
        pattern: args.pattern,
        concurrency: args.concurrency,
        eventId,
        seatIds,
        runs,
        anyDoubleBooked: runs.some((r) => r.anyDoubleBooked),
      };

      const outPath = new URL(
        `../docs/evidence/${strategy}-spread-seats-load-run-${runs[0]!.ranAt.replace(/[:.]/g, "-")}.json`,
        import.meta.url,
      );
      await writeFile(outPath, JSON.stringify(combined, null, 2));
      console.log(`\nReport written to ${outPath.pathname}`);

      if (combined.anyDoubleBooked) {
        process.exitCode = 1;
      }
    }
  }
}

interface DeadlockPairsRunReport {
  attempt: number;
  ranAt: string;
  durationMs: number;
  httpStatusTally: HttpStatusTally;
  // Sum of X-Booking-Retries (ADR-0012) across every response in the run —
  // this and httpStatusTally[503] are the deadlock-rate signal (ADR-0015,
  // issue #25's acceptance criterion: no new instrumentation).
  retriesTotal: number;
  latency: LatencyStats;
  throughputRps: number;
  pairCount: number;
  seatsWithWinner: number;
  seatsDoubleBooked: number;
  winningBookingIds: string[];
  anyDoubleBooked: boolean;
}

async function runDeadlockPairsOnce(
  args: Args,
  pairs: [string, string][],
  attempt: number,
): Promise<DeadlockPairsRunReport> {
  const runId = randomUUID();
  const scriptPath = fileURLToPath(new URL("./deadlock-pairs.k6.js", import.meta.url));
  const summaryPath = fileURLToPath(new URL(`../docs/evidence/.k6-summary-${runId}.json`, import.meta.url));
  await mkdir(new URL("../docs/evidence/", import.meta.url), { recursive: true });

  console.log(`Firing both orderings of ${pairs.length} disjoint seat pairs (${pairs.length * 2} requests) via k6...`);
  const startedAt = new Date();
  const k6Result = spawnSync(
    "k6",
    ["run", `--summary-export=${summaryPath}`, scriptPath],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BASE_URL: args.baseUrl,
        RUN_ID: runId,
        SEAT_PAIRS: JSON.stringify(pairs),
      },
    },
  );
  const finishedAt = new Date();

  if (k6Result.error) {
    throw new Error(
      `Failed to run k6 (is it installed? \`brew install k6\`): ${k6Result.error.message}`,
    );
  }
  if (k6Result.status !== 0) {
    throw new Error(`k6 exited with status ${k6Result.status}`);
  }

  const summary: K6Summary = JSON.parse(await readFile(summaryPath, "utf8"));
  await rm(summaryPath);

  // Ground truth: how many distinct bookings actually claimed each seeded
  // seat, read straight from booking_seats rather than trusting HTTP
  // responses — same invariant check as spread-across-seats, just over the
  // flattened pair seat set.
  const seatIds = pairs.flat();
  const { rows: winningBookings } = await pool.query<{ seat_id: string; booking_id: string }>(
    `SELECT bs.seat_id, bs.booking_id FROM booking_seats bs WHERE bs.seat_id = ANY($1)`,
    [seatIds],
  );

  const { winnersPerSeat, seatsDoubleBooked } = tallyPerSeatWinners(winningBookings);

  const report: DeadlockPairsRunReport = {
    attempt,
    ranAt: startedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    httpStatusTally: {
      201: metricCount(summary, "booking_created"),
      409: metricCount(summary, "booking_conflict"),
      503: metricCount(summary, "booking_retry_exhausted"),
      other: metricCount(summary, "booking_other_status"),
    },
    retriesTotal: metricCount(summary, "booking_retries"),
    latency: {
      p50Ms: metricStat(summary, "http_req_duration", "med"),
      p99Ms: metricStat(summary, "http_req_duration", "p(99)"),
    },
    throughputRps: metricStat(summary, "http_reqs", "rate"),
    pairCount: pairs.length,
    seatsWithWinner: winnersPerSeat.size,
    seatsDoubleBooked,
    // Deduped: a winning booking here spans both seats of its pair, so the
    // ground-truth query above returns two rows (one per seat) for it.
    winningBookingIds: [...new Set(winningBookings.map((r) => r.booking_id))],
    anyDoubleBooked: seatsDoubleBooked > 0,
  };

  console.log(JSON.stringify(report, null, 2));
  if (report.anyDoubleBooked) {
    console.error(
      `\n*** DOUBLE-BOOKING CONFIRMED: ${seatsDoubleBooked} seat(s) had more than one winner. ***`,
    );
  } else {
    // Unlike spread-across-seats, seatsWithWinner < seatIds.length is an
    // expected outcome here, not a bug: a pair where both orderings hit
    // retry_exhausted (ADR-0015) leaves both its seats unclaimed, which the
    // 503 tally above already accounts for — so this doesn't get the same
    // "all X/Y" phrasing spread-across-seats' report uses, since "all" would
    // misdescribe a run with unresolved pairs.
    console.log(
      `\n${report.seatsWithWinner}/${seatIds.length} seats had exactly one winner. ` +
        `Retries: ${report.retriesTotal}, retry-exhausted: ${report.httpStatusTally[503]}.`,
    );
  }

  return report;
}

async function runDeadlockPairsPattern(args: Args) {
  const strategy = process.env.BOOKING_STRATEGY ?? "naive";

  console.log(`Seeding ${args.concurrency} disjoint seat pairs...`);
  const { eventId, pairs } = await seedDeadlockPairs(args.concurrency);

  const runs: DeadlockPairsRunReport[] = [];
  try {
    for (let attempt = 1; attempt <= args.repeat; attempt += 1) {
      console.log(`\n=== Run ${attempt}/${args.repeat} (strategy=${strategy}, pattern=deadlock-pairs) ===`);
      const report = await runDeadlockPairsOnce(args, pairs, attempt);
      runs.push(report);

      if (attempt < args.repeat && report.winningBookingIds.length > 0) {
        console.log(`Resetting ${report.winningBookingIds.length} booking(s) via DELETE /bookings/{id} before the next run...`);
        await resetSeatViaApi(args.baseUrl, report.winningBookingIds);
      }
    }
  } finally {
    // Write whatever repeats completed even if a later one throws — mirrors
    // runHammerPattern/runSpreadPattern's already-verified-repeats-shouldn't
    // -be-lost handling.
    if (runs.length > 0) {
      const combined = {
        strategy,
        pattern: args.pattern,
        concurrency: args.concurrency,
        eventId,
        pairs,
        runs,
        anyDoubleBooked: runs.some((r) => r.anyDoubleBooked),
      };

      const outPath = new URL(
        `../docs/evidence/${strategy}-deadlock-pairs-load-run-${runs[0]!.ranAt.replace(/[:.]/g, "-")}.json`,
        import.meta.url,
      );
      await writeFile(outPath, JSON.stringify(combined, null, 2));
      console.log(`\nReport written to ${outPath.pathname}`);

      if (combined.anyDoubleBooked) {
        process.exitCode = 1;
      }
    }
  }
}

// Same shape as RunReport/SpreadRunReport respectively, minus the per-
// attempt fields (attempt/ranAt/durationMs live on IsolationRunReport
// itself, once, since both streams share one k6 invocation's timing) — kept
// as type aliases rather than hand-retyped interfaces so a field added to
// either pre-existing report shape doesn't silently go undeclared here.
type HotStreamStats = Omit<RunReport, "attempt" | "ranAt" | "durationMs" | "winningUserIds">;
type BackgroundStreamStats = Omit<SpreadRunReport, "attempt" | "ranAt" | "durationMs">;

// Reads the status/retry/latency/throughput fields common to both streams
// off one k6 summary, keyed by the stream's metric-name prefix
// (cross-seat-isolation.k6.js's hot_*/bg_* Counters and Trends) — the
// seat-specific ground-truth fields (winningBookingIds, doubleBooked, ...)
// are layered on by each of runIsolationOnce's two call sites below, since
// those differ in shape between the one-seat hot stream and the many-seat
// background stream.
function buildStreamStats(
  summary: K6Summary,
  prefix: "hot" | "bg",
): Pick<HotStreamStats, "httpStatusTally" | "retriesTotal" | "latency" | "throughputRps"> {
  return {
    httpStatusTally: {
      201: metricCount(summary, `${prefix}_booking_created`),
      409: metricCount(summary, `${prefix}_booking_conflict`),
      503: metricCount(summary, `${prefix}_booking_retry_exhausted`),
      other: metricCount(summary, `${prefix}_booking_other_status`),
    },
    retriesTotal: metricCount(summary, `${prefix}_booking_retries`),
    latency: {
      p50Ms: metricStat(summary, `${prefix}_req_duration`, "med"),
      p99Ms: metricStat(summary, `${prefix}_req_duration`, "p(99)"),
    },
    throughputRps: metricStat(summary, `${prefix}_requests`, "rate"),
  };
}

interface IsolationRunReport {
  attempt: number;
  ranAt: string;
  durationMs: number;
  // null for a --background-only run: no hot-seat stream fired at all,
  // rather than a hot stream that fired zero requests.
  hotStream: HotStreamStats | null;
  backgroundStream: BackgroundStreamStats;
}

async function runIsolationOnce(
  args: Args,
  hotSeatId: string | null,
  backgroundSeatIds: string[],
  backgroundSeatIdsJson: string,
  attempt: number,
): Promise<IsolationRunReport> {
  const runId = randomUUID();
  const scriptPath = fileURLToPath(new URL("./cross-seat-isolation.k6.js", import.meta.url));
  const summaryPath = fileURLToPath(new URL(`../docs/evidence/.k6-summary-${runId}.json`, import.meta.url));
  await mkdir(new URL("../docs/evidence/", import.meta.url), { recursive: true });

  console.log(
    hotSeatId
      ? `Firing ${args.concurrency} concurrent requests at hot seat ${hotSeatId} alongside 1 request each at ${backgroundSeatIds.length} background seats via k6...`
      : `Firing 1 request each at ${backgroundSeatIds.length} background seats via k6 (--background-only, no hot-seat stream)...`,
  );
  const startedAt = new Date();
  const k6Result = spawnSync(
    "k6",
    ["run", `--summary-export=${summaryPath}`, scriptPath],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BASE_URL: args.baseUrl,
        RUN_ID: runId,
        BACKGROUND_SEAT_IDS: backgroundSeatIdsJson,
        // Set explicitly (not just conditionally added) even for
        // --background-only, so a HOT_SEAT_ID/HOT_CONCURRENCY left over in
        // the ambient shell environment (e.g. from manually invoking
        // cross-seat-isolation.k6.js directly while debugging) can't leak
        // through the `...process.env` spread above and fire an unwanted
        // hot-seat stream against a seat never seeded in this run.
        // cross-seat-isolation.k6.js treats "" as unset (`__ENV.HOT_SEAT_ID
        // || undefined`, `Number(__ENV.HOT_CONCURRENCY || 0)`).
        HOT_SEAT_ID: hotSeatId ?? "",
        HOT_CONCURRENCY: hotSeatId ? String(args.concurrency) : "",
      },
    },
  );
  const finishedAt = new Date();

  if (k6Result.error) {
    throw new Error(
      `Failed to run k6 (is it installed? \`brew install k6\`): ${k6Result.error.message}`,
    );
  }
  if (k6Result.status !== 0) {
    throw new Error(`k6 exited with status ${k6Result.status}`);
  }

  const summary: K6Summary = JSON.parse(await readFile(summaryPath, "utf8"));
  await rm(summaryPath);

  // Ground truth for both streams, read straight from booking_seats rather
  // than trusting HTTP responses — two independent queries over disjoint
  // seat sets, fired concurrently rather than one after the other (the hot
  // query resolves to [] immediately for a --background-only run, matching
  // hammer-seat's single-seat invariant check when it does run).
  const [hotWinners, bgWinners] = await Promise.all([
    hotSeatId
      ? pool
          .query<{ booking_id: string }>(
            `SELECT bs.booking_id FROM booking_seats bs WHERE bs.seat_id = $1`,
            [hotSeatId],
          )
          .then((res) => res.rows)
      : Promise.resolve<{ booking_id: string }[]>([]),
    pool
      .query<{ seat_id: string; booking_id: string }>(
        `SELECT bs.seat_id, bs.booking_id FROM booking_seats bs WHERE bs.seat_id = ANY($1)`,
        [backgroundSeatIds],
      )
      .then((res) => res.rows),
  ]);

  const hotStream: HotStreamStats | null = hotSeatId
    ? {
        ...buildStreamStats(summary, "hot"),
        winningBookingIds: hotWinners.map((r) => r.booking_id),
        winningBookingCount: hotWinners.length,
        doubleBooked: hotWinners.length > 1,
      }
    : null;

  const { winnersPerSeat: bgWinnersPerSeat, seatsDoubleBooked: bgSeatsDoubleBooked } =
    tallyPerSeatWinners(bgWinners);

  const backgroundStream: BackgroundStreamStats = {
    ...buildStreamStats(summary, "bg"),
    seatCount: backgroundSeatIds.length,
    seatsWithWinner: bgWinnersPerSeat.size,
    seatsDoubleBooked: bgSeatsDoubleBooked,
    winningBookingIds: bgWinners.map((r) => r.booking_id),
    anyDoubleBooked: bgSeatsDoubleBooked > 0,
  };

  const report: IsolationRunReport = {
    attempt,
    ranAt: startedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    hotStream,
    backgroundStream,
  };

  console.log(JSON.stringify(report, null, 2));
  const anyDoubleBooked = (hotStream?.doubleBooked ?? false) || backgroundStream.anyDoubleBooked;
  if (anyDoubleBooked) {
    console.error(`\n*** DOUBLE-BOOKING CONFIRMED in isolation pattern run ${attempt}. ***`);
  } else if (hotStream) {
    console.log(
      `\nHot seat had exactly ${hotStream.winningBookingCount} winner(s); background: ` +
        `${backgroundStream.seatsWithWinner}/${backgroundStream.seatCount} seats had exactly one winner.`,
    );
  } else {
    console.log(
      `\nBackground-only baseline: ${backgroundStream.seatsWithWinner}/${backgroundStream.seatCount} seats had exactly one winner.`,
    );
  }

  return report;
}

async function runIsolationPattern(args: Args) {
  const strategy = process.env.BOOKING_STRATEGY ?? "naive";

  console.log(
    args.backgroundOnly
      ? `Seeding ${args.concurrency} distinct background seats (--background-only, no hot seat)...`
      : `Seeding ${args.concurrency} distinct background seats + 1 hot seat...`,
  );
  const { eventId: backgroundEventId, seatIds: backgroundSeatIds } = await seedSpreadSeats(args.concurrency);
  // Computed once here rather than inside runIsolationOnce: backgroundSeatIds
  // never changes across a pattern run's --repeat attempts, so there's no
  // reason to re-JSON.stringify the same ~1000-element array on every one.
  const backgroundSeatIdsJson = JSON.stringify(backgroundSeatIds);
  let hotEventId: string | null = null;
  let hotSeatId: string | null = null;
  if (!args.backgroundOnly) {
    const hot = await seedTargetSeat();
    hotEventId = hot.eventId;
    hotSeatId = hot.seatId;
  }

  const runs: IsolationRunReport[] = [];
  try {
    for (let attempt = 1; attempt <= args.repeat; attempt += 1) {
      console.log(
        `\n=== Run ${attempt}/${args.repeat} (strategy=${strategy}, pattern=isolation` +
          `${args.backgroundOnly ? ", background-only" : ""}) ===`,
      );
      const report = await runIsolationOnce(args, hotSeatId, backgroundSeatIds, backgroundSeatIdsJson, attempt);
      runs.push(report);

      if (attempt < args.repeat) {
        const idsToReset = [
          ...(report.hotStream?.winningBookingIds ?? []),
          ...report.backgroundStream.winningBookingIds,
        ];
        if (idsToReset.length > 0) {
          console.log(`Resetting ${idsToReset.length} booking(s) via DELETE /bookings/{id} before the next run...`);
          await resetSeatViaApi(args.baseUrl, idsToReset);
        }
      }
    }
  } finally {
    // Write whatever repeats completed even if a later one throws — mirrors
    // the other three patterns' already-verified-repeats-shouldn't-be-lost
    // handling.
    if (runs.length > 0) {
      const combined = {
        strategy,
        pattern: args.pattern,
        concurrency: args.concurrency,
        backgroundOnly: args.backgroundOnly,
        hotEventId,
        hotSeatId,
        backgroundEventId,
        backgroundSeatIds,
        runs,
        anyDoubleBooked: runs.some(
          (r) => (r.hotStream?.doubleBooked ?? false) || r.backgroundStream.anyDoubleBooked,
        ),
      };

      const suffix = args.backgroundOnly ? "isolation-baseline" : "isolation";
      const outPath = new URL(
        `../docs/evidence/${strategy}-${suffix}-load-run-${runs[0]!.ranAt.replace(/[:.]/g, "-")}.json`,
        import.meta.url,
      );
      await writeFile(outPath, JSON.stringify(combined, null, 2));
      console.log(`\nReport written to ${outPath.pathname}`);

      if (combined.anyDoubleBooked) {
        process.exitCode = 1;
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
