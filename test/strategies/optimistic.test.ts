process.env.BOOKING_STRATEGY = "optimistic";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const { runBookingConcurrencyContractTest, runBookingContractTests } = await import("../bookingContract.js");
const { interceptQuery, resetDb, seedBooking, seedEventWithSeats } = await import("../testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

runBookingContractTests("optimistic", createApp);
runBookingConcurrencyContractTest("optimistic", createApp);

describe("POST /bookings (optimistic strategy) — concurrent cancellation race", () => {
  beforeEach(resetDb);

  it("retries and succeeds when a CAS miss turns out to be a concurrent cancellation, not a competing win", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;
    const { bookingId: canceledBookingId } = await seedBooking([seatId], "user-1");

    // Right after the mechanism's first CAS attempt reports a miss (the seat
    // is still 'booked' from seedBooking above, so this is a plain predicate
    // mismatch, not a lock wait), a second connection commits a
    // cancellation-shaped update — status back to 'available', version
    // bumped — before the mechanism's own re-read runs. This deterministically
    // reproduces ADR-0009's "fresh read still shows available" branch without
    // depending on real inter-request timing or a rare natural coincidence.
    const interceptor = interceptQuery(
      "UPDATE seats SET status = 'booked'",
      async (connect) => {
        const sideEffectClient = await connect();
        try {
          // Mirrors DELETE /bookings/{id}'s effect exactly (booking_seats
          // row gone, seat back to 'available' with a bumped version, the
          // old booking gone) — not just the seats-table update — since the
          // racing request's eventual INSERT INTO booking_seats would
          // otherwise collide with the UNIQUE(seat_id) backstop (ADR-0008)
          // left behind by the canceled booking.
          await sideEffectClient.query("DELETE FROM booking_seats WHERE booking_id = $1", [canceledBookingId]);
          await sideEffectClient.query(
            "UPDATE seats SET status = 'available', booked_by = NULL, version = version + 1 WHERE id = $1",
            [seatId],
          );
          await sideEffectClient.query("DELETE FROM bookings WHERE id = $1", [canceledBookingId]);
        } finally {
          sideEffectClient.release();
        }
      },
      (result) => (result as { rowCount: number | null }).rowCount === 0,
    );

    const app = createApp();
    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatId, user_id: "user-2", idempotency_key: randomUUID() },
      });
    } finally {
      interceptor.restore();
    }

    expect(interceptor.wasTriggered()).toBe(true);
    expect(res.statusCode).toBe(201);
    expect(res.headers["x-booking-retries"]).toBe("1");

    const seatRow = await pool.query("SELECT status, booked_by, version FROM seats WHERE id = $1", [seatId]);
    expect(seatRow.rows[0]).toMatchObject({ status: "booked", booked_by: "user-2", version: 3 });
  });
});
