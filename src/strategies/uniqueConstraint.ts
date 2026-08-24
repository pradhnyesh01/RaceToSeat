import type { PoolClient } from "pg";
import { DeadlockRetriesExhaustedError, pool, withDeadlockRetry } from "../db/pool.js";
import { findExistingBookingByIdempotencyKey, resolveIdempotencyKeyRace } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

// Does no separate availability read: the INSERT ... ON CONFLICT (seat_id) DO
// NOTHING outcome is the sole arbiter of win/loss, so there's no read-write
// gap for a race to land in (unlike naive, which is gap-free only because of
// the same constraint acting as a backstop, not because of how it queries).
//
// Multi-seat deadlock fix (Phase 3, issue #27; ADR-0016's update): seat_ids
// is sorted once, case-insensitively, before any write, and the whole
// transactional attempt is wrapped in withDeadlockRetry (ADR-0014) — same
// fix as naive's (issue #26, Exhibit D), applied here with no separate
// before/after demo since it's the identical Postgres phenomenon (an
// unordered `INSERT ... unnest($ids)` wait-for cycle): ON CONFLICT DO
// NOTHING still has to probe the unique index per row in array order, so two
// concurrent opposite-order requests for the same seat pair can still
// insert-then-block on each other's uncommitted index entry.
export async function bookSeatUniqueConstraint(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    // Lowercased once, then a plain default sort — see naive.ts for why not
    // localeCompare (default sort's UTF-16-code-unit order is stable across
    // processes; localeCompare's ICU-dependent collation isn't).
    const seatIds = input.seatIds.map((seatId) => seatId.toLowerCase()).sort();

    // A seat-existence check, not an availability check: it distinguishes an
    // unknown seat_id (404) from a lost race, which the INSERT below reports.
    // Checked for the whole requested set in one query, before any per-seat
    // INSERT starts, so an unknown seat 404s even if another seat in the same
    // request is already booked.
    const seatRes = await client.query("SELECT 1 FROM seats WHERE id = ANY($1)", [seatIds]);
    if (seatRes.rowCount !== seatIds.length) {
      return { kind: "not_found" };
    }

    try {
      return await withDeadlockRetry(
        client,
        async (txClient, attempt) => {
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
            [booking.id, seatIds],
          );

          if (insertRes.rowCount !== seatIds.length) {
            return { kind: "conflict", retries: attempt };
          }

          await txClient.query(
            "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = ANY($2)",
            [input.userId, seatIds],
          );

          return { kind: "created", bookingId: booking.id, createdAt: booking.created_at, retries: attempt };
        },
        (result) => result.kind === "created",
      );
    } catch (err) {
      if (err instanceof DeadlockRetriesExhaustedError) {
        // ADR-0015: a deadlock abort that exhausts the retry budget is the
        // existing retry_exhausted kind (503), not a new one.
        return { kind: "retry_exhausted", retries: err.retries };
      }
      return await resolveIdempotencyKeyRace(client, input.idempotencyKey, err);
    }
  } finally {
    client.release();
  }
}
