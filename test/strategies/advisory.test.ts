process.env.BOOKING_STRATEGY = "advisory";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const { runBookingConcurrencyContractTest, runBookingContractTests } = await import("../bookingContract.js");
const { resetDb, seedEventWithSeats } = await import("../testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

runBookingContractTests("advisory", createApp);
runBookingConcurrencyContractTest("advisory", createApp);

// Holds the exact advisory-lock key the strategy would derive for
// `lockSeatId` open in an uncommitted transaction on a separate connection,
// standing in for "another session currently holds this lock" while `fn`
// runs. Deterministic, unlike a plain Promise.all race — a request with no
// real contention can simply finish first and never observe the lock at all.
async function withHeldSeatLock<T>(lockSeatId: string, fn: () => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  await lockClient.query("BEGIN");
  await lockClient.query("SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))", [lockSeatId]);
  try {
    return await fn();
  } finally {
    await lockClient.query("COMMIT");
    lockClient.release();
  }
}

describe("POST /bookings (advisory strategy) — non-blocking acquisition", () => {
  beforeEach(resetDb);

  it("a losing request fails immediately, without waiting on the winner's transaction to commit", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;
    const app = createApp();

    // pg_try_advisory_xact_lock (ADR-0006) must fail instantly here rather
    // than queue behind the held lock — if the mechanism used the blocking
    // pg_advisory_xact_lock instead, this would hang until withHeldSeatLock's
    // COMMIT, and the test would time out.
    let elapsedMs = 0;
    const res = await withHeldSeatLock(seatId, async () => {
      const start = Date.now();
      const response = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatId, user_id: "user-1", idempotency_key: randomUUID() },
      });
      elapsedMs = Date.now() - start;
      return response;
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers["x-booking-retries"]).toBe("0");
    // Generous relative to a real block (which would run into vitest's
    // multi-second default test timeout, or hang until the lock releases)
    // — this just confirms "fast", not a tight latency budget.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("a differently-cased spelling of an already-locked seat is still excluded, not let through as a 500", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;
    const app = createApp();

    // hashtext() hashes raw text, not a canonical UUID value — without
    // canonicalizing via ::uuid first, these two spellings of the same seat
    // would hash to different lock keys, letting the request sail straight
    // through the (wrong) lock check to the real seats/booking_seats writes.
    const res = await withHeldSeatLock(seatId.toLowerCase(), () =>
      app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatId.toUpperCase(), user_id: "user-1", idempotency_key: randomUUID() },
      }),
    );

    expect(res.statusCode).toBe(409);

    const seatRow = await pool.query("SELECT status FROM seats WHERE id = $1", [seatId]);
    expect(seatRow.rows[0]).toMatchObject({ status: "available" });
  });

  it("a nonexistent seat 404s even if another session holds the matching advisory-lock key", async () => {
    const app = createApp();
    const unknownSeatId = randomUUID();

    // The lock call lives in the SELECT list, filtered by WHERE first, so it
    // only ever runs for a seat_id that's actually a row (advisory.ts) — a
    // nonexistent seat must never even attempt the lock. If it did, this
    // held lock would make the request lose the (irrelevant) race and
    // return a false 409 instead of 404.
    const res = await withHeldSeatLock(unknownSeatId, () =>
      app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: unknownSeatId, user_id: "user-1", idempotency_key: randomUUID() },
      }),
    );

    expect(res.statusCode).toBe(404);
  });
});
