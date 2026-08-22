import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";

export async function resetDb(): Promise<void> {
  await pool.query("TRUNCATE booking_seats, bookings, seats, events RESTART IDENTITY CASCADE");
}

export async function seedEventWithSeats(seatLabels: string[]): Promise<{ eventId: string; seatIdsByLabel: Record<string, string> }> {
  const eventRes = await pool.query<{ id: string }>(
    "INSERT INTO events (name) VALUES ($1) RETURNING id",
    ["Test Event"],
  );
  const eventId = eventRes.rows[0]!.id;

  const seatIdsByLabel: Record<string, string> = {};
  for (const label of seatLabels) {
    const seatRes = await pool.query<{ id: string }>(
      "INSERT INTO seats (event_id, label) VALUES ($1, $2) RETURNING id",
      [eventId, label],
    );
    seatIdsByLabel[label] = seatRes.rows[0]!.id;
  }

  return { eventId, seatIdsByLabel };
}

// Seeds a booking directly against the DB, bypassing the API — the only way
// to construct a multi-seat booking before Phase 3 adds multi-seat requests.
export async function seedBooking(seatIds: string[], userId: string): Promise<{ bookingId: string }> {
  const bookingRes = await pool.query<{ id: string }>(
    "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id",
    [userId, `seed-${randomUUID()}`],
  );
  const bookingId = bookingRes.rows[0]!.id;

  for (const seatId of seatIds) {
    await pool.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [bookingId, seatId]);
    await pool.query(
      "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = $2",
      [userId, seatId],
    );
  }

  return { bookingId };
}
