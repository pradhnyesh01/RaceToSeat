process.env.BOOKING_STRATEGY = "pessimistic";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const {
  runBookingConcurrencyContractTest,
  runBookingContractTests,
  runCrossSeatIsolationContractTest,
  runIdempotencyKeyReleaseContractTest,
  runMultiSeatBookingContractTests,
} = await import("../bookingContract.js");
const { resetDb, seedEventWithSeats, withHeldRowLock } = await import("../testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

runBookingContractTests("pessimistic", createApp);
runBookingConcurrencyContractTest("pessimistic", createApp);
runMultiSeatBookingContractTests("pessimistic", createApp);
runIdempotencyKeyReleaseContractTest("pessimistic", createApp);
runCrossSeatIsolationContractTest("pessimistic", createApp, withHeldRowLock);

describe("POST /bookings (pessimistic strategy) — multi-seat NOWAIT precedence", () => {
  beforeEach(resetDb);

  it("still 404s for an unknown seat even when NOWAIT fails first on a different, live-locked seat in the same request", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const lockedSeatId = seatIdsByLabel.A1!;
    const app = createApp();

    // FOR UPDATE NOWAIT throws the instant it can't lock ANY requested row —
    // before the not_found check on the query's own (never-produced) result
    // set ever runs. Without a fallback existence check, this would resolve
    // as 409 (a losing lock-acquisition) instead of the 404 precedence every
    // other mechanism (and pessimistic's own already-committed-conflict case)
    // guarantees.
    const res = await withHeldRowLock(lockedSeatId, () =>
      app.inject({
        method: "POST",
        url: "/bookings",
        payload: {
          seat_ids: [lockedSeatId, "00000000-0000-0000-0000-000000000000"],
          user_id: "user-1",
          idempotency_key: randomUUID(),
        },
      }),
    );

    expect(res.statusCode).toBe(404);
  });
});
