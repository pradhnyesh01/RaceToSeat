import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { findExistingBookingByIdempotencyKey, runTransactionalBooking } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

// Does no separate availability read: the INSERT ... ON CONFLICT (seat_id) DO
// NOTHING outcome is the sole arbiter of win/loss, so there's no read-write
// gap for a race to land in (unlike naive, which is gap-free only because of
// the same constraint acting as a backstop, not because of how it queries).
//
// Multi-seat (Phase 3, issue #24): seat_ids is iterated in request order, not
// sorted — ordering is ADR-0016's naive-only demo followed by this
// mechanism's own follow-up ticket, which ships it pre-ordered.
export async function bookSeatUniqueConstraint(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    // A seat-existence check, not an availability check: it distinguishes an
    // unknown seat_id (404) from a lost race, which the INSERT below reports.
    // Checked for the whole requested set in one query, before any per-seat
    // INSERT starts, so an unknown seat 404s even if another seat in the same
    // request is already booked.
    const seatRes = await client.query("SELECT 1 FROM seats WHERE id = ANY($1)", [input.seatIds]);
    if (seatRes.rowCount !== input.seatIds.length) {
      return { kind: "not_found" };
    }

    return await runTransactionalBooking(client, input.idempotencyKey, async (txClient) => {
      const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
        "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
        [input.userId, input.idempotencyKey],
      );
      const booking = bookingRes.rows[0]!;

      // One batched statement, not a per-seat loop: rowCount below the
      // requested seat count means at least one was already claimed, which
      // rolls back this whole attempt (all-or-nothing) — same contract as
      // the single-seat case, just checked as a count instead of a boolean.
      const insertRes = await txClient.query(
        "INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT (seat_id) DO NOTHING",
        [booking.id, input.seatIds],
      );

      if (insertRes.rowCount !== input.seatIds.length) {
        return { kind: "conflict" };
      }

      await txClient.query(
        "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = ANY($2)",
        [input.userId, input.seatIds],
      );

      return { kind: "created", bookingId: booking.id, createdAt: booking.created_at };
    });
  } finally {
    client.release();
  }
}
