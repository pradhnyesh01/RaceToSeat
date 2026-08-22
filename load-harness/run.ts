// Orchestrates concurrency-evidence runs (issue #5, extended by issue #11):
// seeds one target seat, then fires N concurrent-request runs against it via
// k6 (hammer-seat.k6.js), resetting the seat between runs through the real
// HTTP DELETE /bookings/{id} endpoint (issue #8) rather than raw SQL or
// reseeding — the harness exercises the same API surface it's evidencing.
//
// Usage: tsx load-harness/run.ts [--concurrency 1000] [--repeat 2] [--base-url http://localhost:3000]
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { pool } from "../src/db/pool.js";

interface Args {
  concurrency: number;
  baseUrl: string;
  repeat: number;
}

function parsePositiveInt(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { concurrency: 1000, baseUrl: "http://localhost:3000", repeat: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--concurrency") args.concurrency = parsePositiveInt("--concurrency", argv[++i]);
    if (argv[i] === "--base-url") args.baseUrl = String(argv[++i]);
    if (argv[i] === "--repeat") args.repeat = parsePositiveInt("--repeat", argv[++i]);
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

interface K6Summary {
  // k6's --summary-export stores each metric's fields (count, rate, ...)
  // directly on the metric object, not nested under a `.values` key. A
  // Counter that never received a single .add() call in the run (e.g. zero
  // conflicts) is omitted from `metrics` entirely, hence the fallback to 0.
  metrics: Record<string, { count?: number }>;
}

function metricCount(summary: K6Summary, name: string): number {
  return summary.metrics[name]?.count ?? 0;
}

interface RunReport {
  attempt: number;
  ranAt: string;
  durationMs: number;
  httpStatusTally: { 201: number; 409: number; other: number };
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
      other: metricCount(summary, "booking_other_status"),
    },
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

// Resets the seat via the real HTTP API (issue #8's DELETE /bookings/{id}),
// not raw SQL and not reseeding — this run's winning booking(s) are canceled
// so the next repeat starts from a genuinely 'available' seat, exercising the
// same cancellation path a real client would use.
async function resetSeatViaApi(baseUrl: string, bookingIds: string[]): Promise<void> {
  for (const bookingId of bookingIds) {
    const res = await fetch(`${baseUrl}/bookings/${bookingId}`, { method: "DELETE" });
    if (res.status !== 204) {
      throw new Error(`Failed to reset seat: DELETE /bookings/${bookingId} returned ${res.status}`);
    }
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
