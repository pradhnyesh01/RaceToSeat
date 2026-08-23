import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { findExistingBookingByIdempotencyKey, runTransactionalBooking } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

// pg_try_advisory_xact_lock, never the blocking pg_advisory_xact_lock
// (ADR-0006): non-blocking, so a losing request fails immediately rather
// than queuing behind the winner's transaction. hashtext(id::text) maps the
// UUID into the single-bigint overload, accepting ADR-0010's bounded
// cross-seat hash-collision risk — the status check below, not the lock
// itself, is still the actual correctness gate against double-booking.
// Hashing the `id` column (not the client-supplied parameter) means it's
// always Postgres's own canonical `uuid`-type text output regardless of how
// the client spelled it — no separate ::uuid cast needed to canonicalize a
// parameter that no longer feeds the hash directly.
// _xact_ (not the session-scoped variant) releases the lock automatically at
// COMMIT/ROLLBACK, matching runTransactionalBooking's transaction boundary.
//
// The lock call lives in the SELECT list, not a separate query or the WHERE
// clause: WHERE filters by existence first, so pg_try_advisory_xact_lock
// only ever runs for a seat_id that's actually a row — a nonexistent seat
// never attempts the lock at all. Two concurrent requests for the same
// unknown seat_id would otherwise race each other for a lock neither needs,
// nondeterministically turning the loser's 404 into a false 409.
//
// Multi-seat (Phase 3, issue #24): one SELECT ... WHERE id = ANY($1) locks
// (or observes the taken lock for) every requested row in a single
// statement. seat_ids is not sorted here — like pessimistic, pg_try_advisory_
// xact_lock's non-blocking acquisition can't enter a wait-for cycle
// (ADR-0006/ADR-0016); ordering for behavioral consistency is this
// mechanism's own follow-up ticket's job.
export async function bookSeatAdvisory(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    return await runTransactionalBooking(client, input.idempotencyKey, async (txClient) => {
      const seatRes = await txClient.query<{ id: string; status: string; acquired: boolean }>(
        "SELECT id, status, pg_try_advisory_xact_lock(hashtext(id::text)) AS acquired FROM seats WHERE id = ANY($1)",
        [input.seatIds],
      );

      // A seat missing from the result set is unknown — checked before the
      // lock/availability checks below, so it takes precedence over any
      // other seat in the same request already being booked.
      if (seatRes.rows.length !== input.seatIds.length) {
        return { kind: "not_found" };
      }
      if (seatRes.rows.some((seat) => !seat.acquired)) {
        return { kind: "conflict" };
      }
      if (seatRes.rows.some((seat) => seat.status !== "available")) {
        return { kind: "conflict" };
      }

      const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
        "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
        [input.userId, input.idempotencyKey],
      );
      const booking = bookingRes.rows[0]!;

      await txClient.query(
        "INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])",
        [booking.id, input.seatIds],
      );
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
