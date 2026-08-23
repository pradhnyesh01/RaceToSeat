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
//
// Multi-seat (Phase 3, issue #24): one SELECT ... WHERE id = ANY($1) FOR
// UPDATE NOWAIT locks every requested row in a single statement — NOWAIT
// still fails the whole statement immediately if any one row is already
// locked, so the "never queue" contract holds unchanged. seat_ids is not
// sorted here (unlike naive/unique_constraint/optimistic/serializable, this
// mechanism's NOWAIT acquisition can't enter a wait-for cycle in the first
// place, ADR-0006/ADR-0016) — that's this mechanism's own follow-up ticket's
// job, purely for behavioral consistency rather than correctness.
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
        seatRes = await txClient.query<{ id: string; status: string }>(
          "SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE NOWAIT",
          [input.seatIds],
        );
      } catch (err) {
        if (isLockNotAvailable(err)) {
          // NOWAIT throws the instant any one requested row is already
          // locked, before this statement's own result set (and thus the
          // not_found check below) is ever produced — so on its own this
          // catch can't tell "another seat in this request is unknown" from
          // "another seat in this request is mid-transaction". A cheap,
          // non-locking existence check preserves 404-before-409 precedence
          // even in that race, at the cost of one extra query only on this
          // (already-losing) path. Run on a fresh connection, not txClient:
          // the failed statement already left this transaction aborted
          // (25P02), so any further query on txClient before a ROLLBACK
          // would itself fail.
          const existsRes = await pool.query("SELECT 1 FROM seats WHERE id = ANY($1)", [input.seatIds]);
          if (existsRes.rowCount !== input.seatIds.length) {
            return { kind: "not_found" };
          }
          return { kind: "conflict" };
        }
        throw err;
      }

      // A seat missing from the locked result set is unknown — checked
      // before the availability check below, so it takes precedence over any
      // other seat in the same request already being booked.
      if (seatRes.rows.length !== input.seatIds.length) {
        return { kind: "not_found" };
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
