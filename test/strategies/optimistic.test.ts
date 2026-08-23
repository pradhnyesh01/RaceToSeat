process.env.BOOKING_STRATEGY = "optimistic";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const { runBookingConcurrencyContractTest, runBookingContractTests } = await import("../bookingContract.js");
const { resetDb, seedBooking, seedEventWithSeats } = await import("../testDb.js");

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

    const originalConnect = pool.connect.bind(pool);
    let injectedCancellation = false;

    // The mechanism opens one PoolClient per request and runs every query
    // through it. There's no seam to pause a request mid-flight from the
    // outside, so instead we intercept that client's query calls directly:
    // right after its first CAS attempt reports a miss (the seat is still
    // 'booked' from seedBooking above, so this is a plain predicate
    // mismatch, not a lock wait), a second connection commits a
    // cancellation-shaped update — status back to 'available', version
    // bumped — before the mechanism's own re-read runs. This deterministically
    // reproduces ADR-0009's "fresh read still shows available" branch without
    // depending on real inter-request timing or a rare natural coincidence.
    (pool as unknown as { connect: typeof pool.connect }).connect = (async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      (client as unknown as { query: unknown }).query = async (...queryArgs: unknown[]) => {
        const result = (await (originalQuery as (...a: unknown[]) => Promise<unknown>)(...queryArgs)) as {
          rowCount: number | null;
        };
        const first = queryArgs[0];
        const sql = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
        if (!injectedCancellation && sql?.startsWith("UPDATE seats SET status = 'booked'") && result.rowCount === 0) {
          injectedCancellation = true;
          const sideEffectClient = await originalConnect();
          try {
            // Mirrors DELETE /bookings/{id}'s effect exactly (booking_seats
            // row gone, seat back to 'available' with a bumped version, the
            // old booking gone) — not just the seats-table update — since
            // the racing request's eventual INSERT INTO booking_seats would
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
        }
        return result;
      };
      return client;
    }) as typeof pool.connect;

    try {
      const app = createApp();
      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatId, user_id: "user-2", idempotency_key: randomUUID() },
      });

      expect(injectedCancellation).toBe(true);
      expect(res.statusCode).toBe(201);
      expect(res.headers["x-booking-retries"]).toBe("1");
    } finally {
      pool.connect = originalConnect;
    }

    const seatRow = await pool.query("SELECT status, booked_by, version FROM seats WHERE id = $1", [seatId]);
    expect(seatRow.rows[0]).toMatchObject({ status: "booked", booked_by: "user-2", version: 3 });
  });
});
