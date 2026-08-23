process.env.BOOKING_STRATEGY = "optimistic";
// Forces the retry cap to 0 (ADR-0009's default is 3) so an ordinary
// concurrent race — not a rare, hard-to-construct cancellation-timing
// coincidence — deterministically drives every losing request straight to
// retry_exhausted: with no budget left, a CAS miss is never re-read to check
// whether it was a competing win or a cancellation, so a genuine race is
// enough on its own.
process.env.OPTIMISTIC_MAX_RETRIES = "0";

const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const { resetDb, seedEventWithSeats } = await import("../testDb.js");
const { runBookingConcurrencyContractTest } = await import("../bookingContract.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

// Reuses the shared concurrency-contract harness (25 concurrent requests,
// exactly one winner, never 500, X-Booking-Retries: 0 throughout) with the
// losers' expected status overridden to 503 — under a zero retry budget,
// every loss is a retry_exhausted, not an ordinary conflict.
runBookingConcurrencyContractTest("optimistic, max retries = 0", createApp, { loserStatus: 503 });

describe("POST /bookings (optimistic strategy, max retries = 0) — retry exhaustion body", () => {
  beforeEach(resetDb);

  it("every losing response carries a retry_exhausted-shaped error body, not a 409's", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const concurrency = 10;

    const responses = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/bookings",
          payload: { seat_id: seatIdsByLabel.A1, user_id: `user-${i}`, idempotency_key: `race-${i}` },
        }),
      ),
    );

    const losers = responses.filter((res) => res.statusCode === 503);
    expect(losers).toHaveLength(concurrency - 1);
    for (const loser of losers) {
      expect(loser.json()).toMatchObject({ error: expect.any(String) });
    }
  });
});
