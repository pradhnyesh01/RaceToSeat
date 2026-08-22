// Phase 0 load-generation harness: fires N concurrent POST /bookings
// requests at a single seat and verifies the outcome directly against the
// database (not just HTTP response codes, since a racy server can return
// misleading responses under the very bug being demonstrated).
//
// Usage: tsx load-harness/hammer-seat.ts [--concurrency 1000] [--base-url http://localhost:3000]
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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

async function fireRequests(baseUrl: string, seatId: string, concurrency: number) {
  const requests = Array.from({ length: concurrency }, (_, i) =>
    fetch(`${baseUrl}/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seat_id: seatId,
        user_id: `load-user-${i}`,
        idempotency_key: randomUUID(),
      }),
    })
      .then((res) => res.status)
      .catch(() => "network_error" as const),
  );
  return Promise.all(requests);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Seeding target seat...`);
  const { eventId, seatId } = await seedTargetSeat();
  console.log(`Firing ${args.concurrency} concurrent POST /bookings at seat ${seatId}...`);

  const startedAt = new Date();
  const statuses = await fireRequests(args.baseUrl, seatId, args.concurrency);
  const finishedAt = new Date();

  const tally = new Map<string | number, number>();
  for (const status of statuses) {
    tally.set(status, (tally.get(status) ?? 0) + 1);
  }

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
    httpStatusTally: Object.fromEntries(tally),
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

  await mkdir(new URL("../docs/evidence/", import.meta.url), { recursive: true });
  const outPath = new URL(
    `../docs/evidence/naive-load-run-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`,
    import.meta.url,
  );
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${outPath.pathname}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
