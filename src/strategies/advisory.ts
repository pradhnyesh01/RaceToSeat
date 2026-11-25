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
// statement. Like pessimistic, pg_try_advisory_xact_lock's non-blocking
// acquisition can't enter a wait-for cycle (ADR-0006), so sorting seat_ids
// here is not load-bearing for correctness — it's done purely for
// behavioral consistency across mechanisms (issue #30).
export async function bookSeatAdvisory(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    // Lowercased once, then a plain default sort — see naive.ts for why this
    // (not localeCompare) is the collation-safe choice for UUID strings.
    const seatIds = input.seatIds.map((seatId) => seatId.toLowerCase()).sort();

    return await runTransactionalBooking(client, input.idempotencyKey, async (txClient) => {
      // Statement 1: take the locks. Existence is judged here (a seat's row is
      // never deleted, so even a snapshot that predates a concurrent commit
      // is right about it); availability is deliberately NOT read here — see
      // the comment on statement 2.
      const lockRes = await txClient.query<{ id: string; acquired: boolean }>(
        "SELECT id, pg_try_advisory_xact_lock(hashtext(id::text)) AS acquired FROM seats WHERE id = ANY($1)",
        [seatIds],
      );

      // A seat missing from the result set is unknown — checked before the
      // lock/availability checks below, so it takes precedence over any
      // other seat in the same request already being booked.
      if (lockRes.rows.length !== seatIds.length) {
        return { kind: "not_found" };
      }
      if (lockRes.rows.some((seat) => !seat.acquired)) {
        return { kind: "conflict" };
      }

      // Statement 2: read availability, only now that every lock is held
      // (R5, ADR-0027). Under READ COMMITTED each statement takes its own
      // snapshot, so this one is taken after the lock was acquired — and a
      // winner releases its lock only when it commits, so if we hold the lock
      // we also see everything that winner wrote. Reading status in the lock
      // statement itself (the original shape) let a loser's snapshot predate
      // the winner's commit while its lock call ran after the winner's
      // release, passing a stale 'available'; the booking_seats UNIQUE
      // constraint then refused the insert as an unclassified 500. This costs
      // one extra round trip per attempt that gets this far.
      const statusRes = await txClient.query<{ status: string }>(
        "SELECT status FROM seats WHERE id = ANY($1)",
        [seatIds],
      );
      if (statusRes.rows.some((seat) => seat.status !== "available")) {
        return { kind: "conflict" };
      }

      const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
        "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
        [input.userId, input.idempotencyKey],
      );
      const booking = bookingRes.rows[0]!;

      await txClient.query(
        "INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])",
        [booking.id, seatIds],
      );
      await txClient.query(
        "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = ANY($2)",
        [input.userId, seatIds],
      );

      return { kind: "created", bookingId: booking.id, createdAt: booking.created_at };
    });
  } finally {
    client.release();
  }
}
