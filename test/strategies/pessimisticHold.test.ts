process.env.BOOKING_STRATEGY = "pessimistic";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const {
  runHoldConcurrencyContractTest,
  runHoldConfirmContractTests,
  runHoldContractTests,
  runHoldKeyRaceContractTests,
  runHoldKeyReleaseContractTests,
  runMultiSeatHoldContractTests,
} = await import("../holdContract.js");
const { resetDb, seedEventWithSeats, withHeldRowLock } = await import("../testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

runHoldContractTests("pessimistic", createApp);
runHoldConcurrencyContractTest("pessimistic", createApp);
runMultiSeatHoldContractTests("pessimistic", createApp);
runHoldConfirmContractTests("pessimistic", createApp);
runHoldKeyReleaseContractTests("pessimistic", createApp);
runHoldKeyRaceContractTests("pessimistic", createApp, withHeldRowLock);

describe("POST /holds (pessimistic strategy) — NOWAIT conflict", () => {
  beforeEach(resetDb);

  it("409s immediately rather than queuing when another transaction holds the seat's row lock", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const lockedSeatId = seatIdsByLabel.A1!;
    const app = createApp();

    let elapsedMs = 0;
    const res = await withHeldRowLock(lockedSeatId, async () => {
      const start = Date.now();
      const response = await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [lockedSeatId], user_id: "user-1", idempotency_key: randomUUID() },
      });
      elapsedMs = Date.now() - start;
      return response;
    });

    expect(res.statusCode).toBe(409);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("still 404s for an unknown seat even when NOWAIT fails first on a different, live-locked seat in the same request", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const lockedSeatId = seatIdsByLabel.A1!;
    const app = createApp();

    const res = await withHeldRowLock(lockedSeatId, () =>
      app.inject({
        method: "POST",
        url: "/holds",
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

describe("POST /holds/:id/confirm (pessimistic strategy) — NOWAIT conflict", () => {
  beforeEach(resetDb);

  it("409s immediately rather than queuing when a concurrent confirm holds the seat's row lock", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;
    const app = createApp();

    const holdRes = await app.inject({
      method: "POST",
      url: "/holds",
      payload: { seat_ids: [seatId], user_id: "user-1", idempotency_key: randomUUID() },
    });
    const { id: holdId } = holdRes.json() as { id: string };

    let elapsedMs = 0;
    const res = await withHeldRowLock(seatId, async () => {
      const start = Date.now();
      const response = await app.inject({ method: "POST", url: `/holds/${holdId}/confirm` });
      elapsedMs = Date.now() - start;
      return response;
    });

    expect(res.statusCode).toBe(409);
    expect(elapsedMs).toBeLessThan(2000);

    // The losing confirm must not have written anything.
    const bookingCountRes = await pool.query("SELECT count(*)::int AS count FROM bookings");
    expect(bookingCountRes.rows[0].count).toBe(0);
  });
});
