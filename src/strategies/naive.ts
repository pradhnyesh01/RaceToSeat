import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { isUniqueViolation } from "../db/pgErrors.js";
import { findExistingBookingByIdempotencyKey, runTransactionalBooking } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

// Deliberately naive: reads seat status, then writes, with no locking and no
// transaction isolation guarding the gap between the two. Two concurrent
// requests for the same seat can both observe 'available' before either
// commits its write — this was Phase 0's Exhibit A bug. Since ADR-0008 added
// a shared UNIQUE constraint on booking_seats.seat_id, the race can no longer
// produce a double-booking: the loser's INSERT now fails at the constraint
// and is caught below, so naive is safe under concurrency even though its
// read-then-write shape is unchanged.
export async function bookSeatNaive(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    const seatRes = await client.query<{ status: string }>(
      "SELECT status FROM seats WHERE id = $1",
      [input.seatId],
    );
    const seat = seatRes.rows[0];
    if (!seat) {
      return { kind: "not_found" };
    }
    if (seat.status !== "available") {
      return { kind: "conflict" };
    }

    return await runTransactionalBooking(client, input.idempotencyKey, async (txClient) => {
      const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
        "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
        [input.userId, input.idempotencyKey],
      );
      const booking = bookingRes.rows[0]!;

      try {
        await txClient.query(
          "INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)",
          [booking.id, input.seatId],
        );
      } catch (err) {
        if (isUniqueViolation(err, "booking_seats_seat_id_key")) {
          return { kind: "conflict" };
        }
        throw err;
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
