import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { isLockNotAvailable } from "../db/pgErrors.js";
import { findExistingBookingByIdempotencyKey, runTransactionalBooking } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

// SELECT ... FOR UPDATE NOWAIT, never a plain blocking FOR UPDATE (ADR-0006):
// a losing request fails immediately with 55P03 rather than queuing behind
// the winner's transaction, so contention on one seat never adds latency to
// requests for unrelated seats.
export async function bookSeatPessimistic(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    return await runTransactionalBooking(client, input.idempotencyKey, async (txClient) => {
      let seatRes;
      try {
        seatRes = await txClient.query<{ status: string }>(
          "SELECT status FROM seats WHERE id = $1 FOR UPDATE NOWAIT",
          [input.seatId],
        );
      } catch (err) {
        if (isLockNotAvailable(err)) {
          return { kind: "conflict" };
        }
        throw err;
      }

      const seat = seatRes.rows[0];
      if (!seat) {
        return { kind: "not_found" };
      }
      if (seat.status !== "available") {
        return { kind: "conflict" };
      }

      const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
        "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
        [input.userId, input.idempotencyKey],
      );
      const booking = bookingRes.rows[0]!;

      await txClient.query(
        "INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)",
        [booking.id, input.seatId],
      );
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
