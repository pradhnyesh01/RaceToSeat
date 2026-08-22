import { randomUUID } from "node:crypto";

// Cancellation is mechanism-independent, but pin a strategy explicitly rather
// than relying on config.ts's "naive" default: vitest.config.ts's
// fileParallelism: false runs every test file sequentially in one process,
// with nothing resetting process.env between files, so an unpinned default
// here would silently pick up whatever BOOKING_STRATEGY a strategy test file
// that ran earlier left behind.
process.env.BOOKING_STRATEGY = "naive";

const { createApp } = await import("../src/app.js");
const { pool } = await import("../src/db/pool.js");
const { resetDb, seedBooking, seedEventWithSeats } = await import("./testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

describe("DELETE /bookings/:id", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("cancels a booking, releasing the seat back to available", async () => {
    const { eventId, seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();

    const bookRes = await app.inject({
      method: "POST",
      url: "/bookings",
      payload: { seat_id: seatIdsByLabel.A1, user_id: "user-1", idempotency_key: randomUUID() },
    });
    const { id: bookingId } = bookRes.json() as { id: string };

    const deleteRes = await app.inject({ method: "DELETE", url: `/bookings/${bookingId}` });
    expect(deleteRes.statusCode).toBe(204);

    const seatsRes = await app.inject({ method: "GET", url: `/seats?event_id=${eventId}` });
    const { seats } = seatsRes.json() as { seats: { label: string; status: string; booked_by: string | null }[] };
    const seatA1 = seats.find((s) => s.label === "A1")!;
    expect(seatA1.status).toBe("available");
    expect(seatA1.booked_by).toBeNull();
  });

  it("releases every seat in a multi-seat booking", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2", "A3"]);
    const { bookingId } = await seedBooking([seatIdsByLabel.A1!, seatIdsByLabel.A2!], "user-1");
    const app = createApp();

    const deleteRes = await app.inject({ method: "DELETE", url: `/bookings/${bookingId}` });
    expect(deleteRes.statusCode).toBe(204);

    const seatsRes = await pool.query(
      "SELECT label, status, booked_by FROM seats WHERE id = ANY($1)",
      [[seatIdsByLabel.A1, seatIdsByLabel.A2]],
    );
    for (const row of seatsRes.rows) {
      expect(row.status).toBe("available");
      expect(row.booked_by).toBeNull();
    }

    const bookingSeatsRes = await pool.query("SELECT * FROM booking_seats WHERE booking_id = $1", [bookingId]);
    expect(bookingSeatsRes.rows).toHaveLength(0);

    // A3 was never part of the booking and must be untouched.
    const seatA3 = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A3]);
    expect(seatA3.rows[0].status).toBe("available");
  });

  it("404s for an unknown booking id", async () => {
    const app = createApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/bookings/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s (not 500) for a malformed booking id", async () => {
    const app = createApp();
    const res = await app.inject({ method: "DELETE", url: "/bookings/not-a-uuid" });
    expect(res.statusCode).toBe(404);
  });

  it("404s on a second DELETE of an already-canceled booking", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();

    const bookRes = await app.inject({
      method: "POST",
      url: "/bookings",
      payload: { seat_id: seatIdsByLabel.A1, user_id: "user-1", idempotency_key: randomUUID() },
    });
    const { id: bookingId } = bookRes.json() as { id: string };

    const first = await app.inject({ method: "DELETE", url: `/bookings/${bookingId}` });
    const second = await app.inject({ method: "DELETE", url: `/bookings/${bookingId}` });

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(404);
  });

  it("has no ownership check — any caller with a valid booking id can cancel it", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();

    const bookRes = await app.inject({
      method: "POST",
      url: "/bookings",
      payload: { seat_id: seatIdsByLabel.A1, user_id: "owner", idempotency_key: randomUUID() },
    });
    const { id: bookingId } = bookRes.json() as { id: string };

    // No user_id / auth is sent with the DELETE at all — cancellation is
    // reachable by booking id alone.
    const res = await app.inject({ method: "DELETE", url: `/bookings/${bookingId}` });
    expect(res.statusCode).toBe(204);
  });
});
