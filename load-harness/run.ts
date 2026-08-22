// Orchestrates the Phase 0 concurrency-evidence run (issue #5): seeds a
// fresh target seat, delegates the actual concurrent load generation to k6
// (hammer-seat.k6.js), then verifies the outcome directly against the
// database and writes the evidence artifact.
//
// Usage: tsx load-harness/run.ts [--concurrency 1000] [--base-url http://localhost:3000]
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { pool } from "../src/db/pool.js";

interface Args {
  concurrency: number;
  baseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { concurrency: 1000, baseUrl: "http://localhost:3000" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--concurrency") args.concurrency = Number(argv[++i]);
    if (argv[i] === "--base-url") args.baseUrl = String(argv[++i]);
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
  const runId = randomUUID();

  console.log("Seeding target seat...");
  const { eventId, seatId } = await seedTargetSeat();

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

  const report = {
    ranAt: startedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    strategy: process.env.BOOKING_STRATEGY ?? "naive",
    concurrency: args.concurrency,
    eventId,
    seatId,
    httpStatusTally: {
      201: metricCount(summary, "booking_created"),
      409: metricCount(summary, "booking_conflict"),
      other: metricCount(summary, "booking_other_status"),
    },
    winningBookingCount: winningBookings.length,
    winningUserIds: winningBookings.map((r) => r.user_id),
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

  const outPath = new URL(
    `../docs/evidence/naive-load-run-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`,
    import.meta.url,
  );
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${outPath.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
