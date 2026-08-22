import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { findExistingBookingByIdempotencyKey, runTransactionalBooking } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

// Does no separate availability read: the INSERT ... ON CONFLICT (seat_id) DO
// NOTHING outcome is the sole arbiter of win/loss, so there's no read-write
// gap for a race to land in (unlike naive, which is gap-free only because of
// the same constraint acting as a backstop, not because of how it queries).
export async function bookSeatUniqueConstraint(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    // A seat-existence check, not an availability check: it distinguishes an
    // unknown seat_id (404) from a lost race, which the INSERT below reports.
    const seatRes = await client.query("SELECT 1 FROM seats WHERE id = $1", [input.seatId]);
    if (seatRes.rows.length === 0) {
      return { kind: "not_found" };
    }

    return await runTransactionalBooking(client, input.idempotencyKey, async (txClient) => {
      const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
        "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
        [input.userId, input.idempotencyKey],
      );
      const booking = bookingRes.rows[0]!;

      const insertRes = await txClient.query(
        "INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2) ON CONFLICT (seat_id) DO NOTHING",
        [booking.id, input.seatId],
      );

      if (insertRes.rowCount === 0) {
        return { kind: "conflict" };
      }

      await txClient.query(
        "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = $2",
        [input.userId, input.seatId],
      );

      return { kind: "created", bookingId: booking.id, createdAt: booking.created_at };
    });
  } finally {
    client.release();
  }
}
