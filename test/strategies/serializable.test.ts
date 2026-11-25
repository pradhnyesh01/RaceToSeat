process.env.BOOKING_STRATEGY = "serializable";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const {
  runBookingConcurrencyContractTest,
  runBookingContractTests,
  runCrossSeatIsolationContractTest,
  runMultiSeatBookingContractTests,
} = await import("../bookingContract.js");
const { commitBookingOnClient, interceptQuery, resetDb, seedEventWithSeats } = await import("../testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

runBookingContractTests("serializable", createApp);
runMultiSeatBookingContractTests("serializable", createApp);

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

// Holds this mechanism's own distinguishing shape — a real SERIALIZABLE
// transaction that reads and then writes `lockSeatId`, exactly like
// withSerializableTransaction's own read-then-write body — open and
// uncommitted on a separate connection, standing in for another in-flight
// serializable booking mid-transaction. This is the one mechanism where
// cross-seat isolation isn't just about row locks: SSI's predicate locks can
// span a page (or, under a seq-scan plan, a whole relation), so it's worth
// proving directly rather than assuming it's identical to the row-lock
// mechanisms. Rolled back, not committed — a rolled-back transaction can
// never participate in an SSI conflict cycle, so this only tests for
// unwanted blocking/latency, not for a spurious 40001 on the concurrent
// request (that "legitimately nonzero" retry rate is covered above, ADR-0013).
async function withOpenSerializableUpdate<T>(lockSeatId: string, fn: () => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  await lockClient.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await lockClient.query("SELECT id, status FROM seats WHERE id = ANY($1)", [[lockSeatId]]);
  await lockClient.query(
    "UPDATE seats SET status = 'booked', booked_by = 'lock-holder', version = version + 1 WHERE id = $1",
    [lockSeatId],
  );
  try {
    return await fn();
  } finally {
    await lockClient.query("ROLLBACK");
    lockClient.release();
  }
}

// checkZeroRetries/acceptableLoserStatuses don't apply here — this test
// doesn't race for the same seat, so there's no loser to make assertions
// about — but the same "unwanted blocking/latency, not a spurious 40001" note
// from the doc comment above applies: withOpenSerializableUpdate rolls back
// rather than commits, so it can never participate in an SSI conflict cycle.
runCrossSeatIsolationContractTest("serializable", createApp, withOpenSerializableUpdate);

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
    const interceptor = interceptQuery("SELECT id, status FROM seats", async (connect) => {
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
        payload: { seat_ids: [seatId], user_id: "user-1", idempotency_key: randomUUID() },
      });
    } finally {
      interceptor.restore();
    }

    expect(interceptor.wasTriggered()).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.headers["x-booking-retries"]).toBe("0");
  });
});
