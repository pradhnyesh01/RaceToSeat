process.env.BOOKING_STRATEGY = "serializable";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const { runBookingConcurrencyContractTest, runBookingContractTests } = await import("../bookingContract.js");
const { commitBookingOnClient, interceptQuery, resetDb, seedEventWithSeats } = await import("../testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

runBookingContractTests("serializable", createApp);

// checkZeroRetries: false — under real SERIALIZABLE contention, a losing
// request can only discover the seat was taken by retrying the whole
// transaction and re-reading (unlike optimistic's cheap re-read-before-
// retrying), so its ordinary losers legitimately report a nonzero
// X-Booking-Retries count here, not 0.
//
// acceptableLoserStatuses: [409, 503] — a loser resolving via the
// booking_seats UNIQUE-constraint backstop (23505) returns an ordinary
// conflict/409, but one whose own read genuinely raced the winner's commit
// can hit a real SERIALIZABLE conflict (40001) and, at the production
// default of 5 retries, exhaust that budget for 503 instead (vanishingly
// unlikely in practice but not structurally impossible under CI scheduling
// jitter — confirmed the split itself is real and timing-dependent, not
// fixed, in test/strategies/serializableRetryExhaustion.test.ts).
runBookingConcurrencyContractTest("serializable", createApp, {
  checkZeroRetries: false,
  acceptableLoserStatuses: [409, 503],
});

describe("POST /bookings (serializable strategy) — ordinary conflict via the unique-constraint backstop", () => {
  beforeEach(resetDb);

  it("a request that loses via booking_seats' unique constraint (not a genuine SERIALIZABLE conflict) reports X-Booking-Retries: 0", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;
    const app = createApp();

    // In the common single-seat race, this — not Postgres's SSI conflict
    // detection — is what usually resolves the loser (ADR-0013). That path
    // returns a plain { kind: "conflict", retries: attempt } with attempt
    // still 0, so this guards against a regression where that local catch
    // is accidentally removed or changed to rethrow (which would route the
    // 23505 through withSerializableTransaction's retry logic — though a
    // 23505 isn't a serialization failure, so it wouldn't retry there
    // either; it would instead propagate all the way to an uncaught 500).
    const interceptor = interceptQuery("SELECT status FROM seats", async (connect) => {
      const winnerClient = await connect();
      try {
        // Plain BEGIN, deliberately not SERIALIZABLE: confirmed empirically
        // this is what produces an ordinary 23505 for the loser rather than
        // a genuine 40001 (see withSerializableTransaction's doc comment in
        // src/db/pool.ts and the counter-case in
        // serializableRetryExhaustion.test.ts).
        await winnerClient.query("BEGIN");
        await commitBookingOnClient(winnerClient, seatId, "winner");
        await winnerClient.query("COMMIT");
      } finally {
        winnerClient.release();
      }
    });

    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatId, user_id: "user-1", idempotency_key: randomUUID() },
      });
    } finally {
      interceptor.restore();
    }

    expect(interceptor.wasTriggered()).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.headers["x-booking-retries"]).toBe("0");
  });
});
