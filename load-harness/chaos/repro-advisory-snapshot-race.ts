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
//
// Part 1 replays that interleaving in raw SQL: it demonstrates the window and
// that the backstop holds, and is unchanged by the R5 fix (issue #58, ADR-0027).
// Part 2 drives the SAME interleaving through the real app (createApp, advisory
// strategy) on a fresh seat — the loser's lock-acquiring statement gets a
// pg_sleep ahead of the lock call, and a full winning booking goes through the
// app while it sleeps — and prints the HTTP statuses. Before the fix the loser
// answered 500 (23505); after it, 409 with no booking row. Exit code is 1 if
// the loser is anything but a 409 with no row.
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
  console.log("B INSERT booking_seats ->", (e as { code?: string }).code, (e as { constraint?: string }).constraint, "(the pre-fix advisory.ts surfaced this as HTTP 500; Part 2 shows the fixed answer)");
}
await B.query("ROLLBACK").catch(() => undefined);
await A.end();
await B.end();

// ---- Part 2: the same interleaving through the real app -------------------
console.log("\n-- Part 2: through the real app (createApp, BOOKING_STRATEGY=advisory) --");
process.env.DATABASE_URL = scratch.connectionString;
process.env.BOOKING_STRATEGY = "advisory";
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const seat2 = (await scratch.pool.query("INSERT INTO seats (event_id,label) VALUES ($1,'A2') RETURNING id", [ev])).rows[0].id;
const app = createApp();
let triggered = false;
let winner: Awaited<ReturnType<typeof app.inject>> | undefined;
const originalConnect = pool.connect.bind(pool);
(pool as unknown as { connect: typeof pool.connect }).connect = (async () => {
  const client = await originalConnect();
  const originalQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  (client as unknown as { query: unknown }).query = async (...queryArgs: unknown[]) => {
    const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : undefined;
    if (!triggered && sql?.includes("pg_try_advisory_xact_lock(")) {
      triggered = true;
      const pending = originalQuery(
        sql.replace("pg_try_advisory_xact_lock(", "pg_sleep(0.6) IS NOT NULL AS paused, pg_try_advisory_xact_lock("),
        ...queryArgs.slice(1),
      );
      await new Promise((r) => setTimeout(r, 150));
      winner = await app.inject({ method: "POST", url: "/bookings", payload: { seat_ids: [seat2], user_id: "w", idempotency_key: "kw" } });
      return pending;
    }
    return originalQuery(...queryArgs);
  };
  return client;
}) as typeof pool.connect;
const loser = await app.inject({ method: "POST", url: "/bookings", payload: { seat_ids: [seat2], user_id: "l", idempotency_key: "kl" } });
pool.connect = originalConnect;
const loserRows = (await scratch.pool.query("SELECT count(*)::int AS n FROM bookings WHERE idempotency_key = 'kl'")).rows[0].n;
console.log("winner HTTP", winner?.statusCode, "| loser HTTP", loser.statusCode, "| loser booking rows:", loserRows);
if (!triggered || winner?.statusCode !== 201 || loser.statusCode !== 409 || loserRows !== 0) {
  console.log("FAIL: expected winner 201, loser 409 with no booking row");
  process.exitCode = 1;
} else {
  console.log("PASS: loser answered 409, no booking row left behind");
}
await pool.end();
await scratch.drop();
