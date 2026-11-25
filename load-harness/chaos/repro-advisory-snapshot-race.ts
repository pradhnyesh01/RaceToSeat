// Deterministic reproduction of the latent `advisory` race that the C2 matrix
// surfaced once (issue #49; docs/evidence/chaos-c2-fault-matrix.md, finding R5).
// Not a test (it demonstrates a defect rather than guarding a behavior) and not
// part of the matrix: run by hand with
//   npx tsx load-harness/chaos/repro-advisory-snapshot-race.ts
// It re-creates, on a throwaway database, the interleaving advisory.ts's single
//   SELECT id, status, pg_try_advisory_xact_lock(...) FROM seats WHERE id = ANY($1)
// is exposed to: a loser's statement takes its snapshot (status 'available'),
// the winner then commits and releases the advisory lock, and only afterwards
// does the loser's statement evaluate pg_try_advisory_xact_lock — which succeeds
// against the stale status. A `pg_sleep` between the two stands in for the
// microseconds a real statement spends there. The UNIQUE(seat_id) backstop
// (ADR-0008) then refuses the second booking: no double-booking, but the
// route surfaces the 23505 as an unclassified HTTP 500 instead of a 409.
import "dotenv/config";
import { Client } from "pg";
import { createScratchDb } from "./scratchDb.js";

const scratch = await createScratchDb(process.env.DATABASE_URL!, []);
const ev = (await scratch.pool.query("INSERT INTO events (name) VALUES ('x') RETURNING id")).rows[0].id;
const seat = (await scratch.pool.query("INSERT INTO seats (event_id,label) VALUES ($1,'A1') RETURNING id", [ev])).rows[0].id;
const connect = async () => {
  const c = new Client({ connectionString: scratch.connectionString });
  await c.connect();
  return c;
};
const A = await connect();
const B = await connect();

// A: the winner — takes the advisory lock and books the seat, not yet committed.
await A.query("BEGIN");
const a = await A.query("SELECT status, pg_try_advisory_xact_lock(hashtext(id::text)) AS acquired FROM seats WHERE id = $1", [seat]);
console.log("A:", a.rows[0]);
await A.query("INSERT INTO bookings (user_id, idempotency_key) VALUES ('a','ka')");

// B: the loser's identical SELECT, paused between snapshot and lock evaluation.
await B.query("BEGIN");
const bq = B.query(
  "SELECT status, pg_sleep(0.6) IS NOT NULL AS paused, pg_try_advisory_xact_lock(hashtext(id::text)) AS acquired FROM seats WHERE id = $1",
  [seat],
);
await new Promise((r) => setTimeout(r, 200));

// A commits during B's pause: books the seat and releases the advisory lock.
const bookingId = (await A.query("SELECT id FROM bookings WHERE idempotency_key='ka'")).rows[0].id;
await A.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1,$2)", [bookingId, seat]);
await A.query("UPDATE seats SET status='booked' WHERE id=$1", [seat]);
await A.query("COMMIT");

const b = await bq;
console.log("B:", b.rows[0], "<- stale status (snapshot predates A's commit) AND lock acquired (A already released it)");
await B.query("INSERT INTO bookings (user_id, idempotency_key) VALUES ('b','kb')");
const bid = (await B.query("SELECT id FROM bookings WHERE idempotency_key='kb'")).rows[0].id;
try {
  await B.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1,$2)", [bid, seat]);
  console.log("B inserted — DOUBLE BOOKING (the backstop did not hold)");
  process.exitCode = 1;
} catch (e) {
  console.log("B INSERT booking_seats ->", (e as { code?: string }).code, (e as { constraint?: string }).constraint, "(advisory.ts surfaces this as HTTP 500)");
}
await B.query("ROLLBACK").catch(() => undefined);
await A.end();
await B.end();
await scratch.drop();
