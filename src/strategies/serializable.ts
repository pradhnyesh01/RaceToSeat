import type { PoolClient } from "pg";
import { SerializationRetriesExhaustedError, pool, withSerializableTransaction } from "../db/pool.js";
import { isUniqueViolation } from "../db/pgErrors.js";
import { findExistingBookingByIdempotencyKey, resolveIdempotencyKeyRace } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

export interface BookSeatSerializableOptions {
  maxRetries?: number;
}

// Runs entirely under SERIALIZABLE isolation via its own
// withSerializableTransaction (ADR-0011), not the shared runTransactionalBooking
// / withTransaction every other mechanism funnels through at plain READ
// COMMITTED — a serialization failure means the whole transaction gets
// replayed from BEGIN, re-reading fresh state, which none of the other
// mechanisms need. The idempotency-key-race fallback (resolveIdempotencyKeyRace)
// IS shared, though: that race is a plain 23505 outside any retry loop,
// unrelated to isolation level, so there's no reason to duplicate it here.
export async function bookSeatSerializable(
  input: BookSeatInput,
  options: BookSeatSerializableOptions = {},
): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    try {
      return await withSerializableTransaction(
        client,
        async (txClient, attempt) => {
          const seatRes = await txClient.query<{ status: string }>(
            "SELECT status FROM seats WHERE id = $1",
            [input.seatId],
          );
          const seat = seatRes.rows[0];
          if (!seat) {
            return { kind: "not_found" };
          }
          if (seat.status !== "available") {
            return { kind: "conflict", retries: attempt };
          }

          const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
            "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
            [input.userId, input.idempotencyKey],
          );
          const booking = bookingRes.rows[0]!;

          // The booking_seats.seat_id UNIQUE constraint (ADR-0008) is a real
          // index-level check, not subject to snapshot isolation — two
          // transactions racing for the same seat that both pass the status
          // check above (a genuine SERIALIZABLE race) resolve here via a
          // plain 23505 well before Postgres's serialization-failure
          // detection would fire, the same as naive's backstop.
          try {
            await txClient.query(
              "INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)",
              [booking.id, input.seatId],
            );
          } catch (err) {
            if (isUniqueViolation(err, "booking_seats_seat_id_key")) {
              return { kind: "conflict", retries: attempt };
            }
            throw err;
          }
          await txClient.query(
            "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = $2",
            [input.userId, input.seatId],
          );

          return { kind: "created", bookingId: booking.id, createdAt: booking.created_at, retries: attempt };
        },
        (result) => result.kind === "created",
        { maxRetries: options.maxRetries },
      );
    } catch (err) {
      if (err instanceof SerializationRetriesExhaustedError) {
        return { kind: "retry_exhausted", retries: err.retries };
      }
      return await resolveIdempotencyKeyRace(client, input.idempotencyKey, err);
    }
  } finally {
    client.release();
  }
}
