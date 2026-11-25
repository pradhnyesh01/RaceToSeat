process.env.BOOKING_STRATEGY = "advisory";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const { resetDb, seedEventWithSeats } = await import("../testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

// Finding R5 (issue #58): the advisory mechanism used to read a seat's status
// and evaluate pg_try_advisory_xact_lock in ONE statement, so a loser's
// snapshot could still show the seat 'available' after the winner had already
// committed and released the lock — the lock then succeeded against a stale
// status, and only the UNIQUE(seat_id) backstop (ADR-0008) stopped the second
// booking, as an unclassified 500 instead of a 409.
//
// A real race hits that window for microseconds, so this test widens it the
// way load-harness/chaos/repro-advisory-snapshot-race.ts does: the loser's
// lock statement gets a pg_sleep ahead of the lock call (the SELECT list is
// evaluated left to right, after the statement took its snapshot), and while
// it sleeps a complete winning booking goes through the real app. Whatever
// shape the mechanism's statements take, the loser's *lock-acquiring*
// statement is the one paused, so the test is agnostic to whether status is
// read in the same statement or a later one.
describe("POST /bookings (advisory strategy) — stale-snapshot race (R5)", () => {
  beforeEach(resetDb);

  it("a loser whose snapshot predates the winner's commit gets 409, not a 500, and leaves no booking behind", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;
    const app = createApp();

    let triggered = false;
    let winnerResponse: Awaited<ReturnType<typeof app.inject>> | undefined;
    const originalConnect = pool.connect.bind(pool);
    (pool as unknown as { connect: typeof pool.connect }).connect = (async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (...queryArgs: unknown[]) => {
        const first = queryArgs[0];
        const sql = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
        if (!triggered && sql?.includes("pg_try_advisory_xact_lock(")) {
          triggered = true;
          const paused = sql.replace(
            "pg_try_advisory_xact_lock(",
            "pg_sleep(0.6) IS NOT NULL AS paused, pg_try_advisory_xact_lock(",
          );
          const pending = originalQuery(paused, ...queryArgs.slice(1));
          // The loser's statement is now in flight (snapshot taken, lock not
          // yet evaluated). Let it get into its sleep, then run a complete
          // winning booking for the same seat through the real app.
          await new Promise((resolve) => setTimeout(resolve, 150));
          winnerResponse = await app.inject({
            method: "POST",
            url: "/bookings",
            payload: { seat_ids: [seatId], user_id: "winner", idempotency_key: randomUUID() },
          });
          return pending;
        }
        return originalQuery(...queryArgs);
      };
      return client;
    }) as typeof pool.connect;

    let loserResponse: Awaited<ReturnType<typeof app.inject>>;
    try {
      loserResponse = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_ids: [seatId], user_id: "loser", idempotency_key: randomUUID() },
      });
    } finally {
      pool.connect = originalConnect;
    }

    expect(triggered).toBe(true);
    expect(winnerResponse?.statusCode).toBe(201);
    expect(loserResponse.statusCode).toBe(409);
    expect(loserResponse.headers["x-booking-retries"]).toBe("0");

    // The loser must leave nothing behind: exactly the winner's booking, and
    // the seat still belongs to the winner.
    const bookings = await pool.query("SELECT user_id FROM bookings");
    expect(bookings.rows).toEqual([{ user_id: "winner" }]);
    const bookingSeats = await pool.query("SELECT seat_id FROM booking_seats");
    expect(bookingSeats.rows).toEqual([{ seat_id: seatId }]);
    const seatRow = await pool.query("SELECT status, booked_by FROM seats WHERE id = $1", [seatId]);
    expect(seatRow.rows[0]).toMatchObject({ status: "booked", booked_by: "winner" });
  });
});
