import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { findExistingBookingByIdempotencyKey, runTransactionalBooking } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

// pg_try_advisory_xact_lock, never the blocking pg_advisory_xact_lock
// (ADR-0006): non-blocking, so a losing request fails immediately rather
// than queuing behind the winner's transaction. hashtext(seat_id::text)
// maps the UUID into the single-bigint overload, accepting ADR-0010's
// bounded cross-seat hash-collision risk — the status check below, not the
// lock itself, is still the actual correctness gate against double-booking.
// The ::uuid cast before ::text canonicalizes the client-supplied string
// first: hashtext hashes raw bytes, so two differently-cased spellings of
// the same UUID would otherwise hash to different lock keys and both
// acquire, unlike every other mechanism's exclusion (a real `uuid`-typed
// column comparison, which Postgres already canonicalizes).
// _xact_ (not the session-scoped variant) releases the lock automatically at
// COMMIT/ROLLBACK, matching runTransactionalBooking's transaction boundary.
//
// The lock call lives in the SELECT list, not a separate query or the WHERE
// clause: WHERE filters by existence first, so pg_try_advisory_xact_lock
// only ever runs for a seat_id that's actually a row — a nonexistent seat
// never attempts the lock at all. Two concurrent requests for the same
// unknown seat_id would otherwise race each other for a lock neither needs,
// nondeterministically turning the loser's 404 into a false 409.
export async function bookSeatAdvisory(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    return await runTransactionalBooking(client, input.idempotencyKey, async (txClient) => {
      const seatRes = await txClient.query<{ status: string; acquired: boolean }>(
        "SELECT status, pg_try_advisory_xact_lock(hashtext($1::uuid::text)) AS acquired FROM seats WHERE id = $1",
        [input.seatId],
      );
      const seat = seatRes.rows[0];
      if (!seat) {
        return { kind: "not_found" };
      }
      if (!seat.acquired) {
        return { kind: "conflict" };
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
