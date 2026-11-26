import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { isUniqueViolation } from "../db/pgErrors.js";
import {
  findPriorBookingForKey,
  normalizeSeatIds,
  replayInsteadOfConflict,
  runDeadlockRetryBooking,
} from "./idempotency.js";
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
//
// Multi-seat deadlock fix (Phase 3, issue #26; "before" baseline was ADR-0016
// via issue #24, measured in Exhibit D): seat_ids is sorted once,
// case-insensitively, before any write. The wait-for cycle Exhibit D actually
// measured wasn't in the UPDATE below — Postgres's `WHERE id = ANY(...)`
// plans that as an index/bitmap scan whose row-visitation order is
// plan-determined, not array-order-determined, so two opposite-order arrays
// still lock those rows in the same order and can't deadlock there. It was in
// the booking_seats INSERT: `unnest($ids)` inserts rows in exactly the
// array's order, so two concurrent opposite-order requests for the same pair
// of seats really can insert-then-block on each other's uncommitted unique-
// index entry in a genuine cycle (confirmed via the deadlock-pairs harness,
// issue #25 — Postgres error 40P01, `while inserting index tuple ... in
// relation "booking_seats_seat_id_key"`). Sorting first means every request
// for the same seat set inserts in the same order regardless of how the
// client listed them, which is the primary fix; withDeadlockRetry (ADR-0014)
// below is the fallback layer for whatever ordering doesn't cover.
export async function bookSeatNaive(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const prior = await findPriorBookingForKey(client, input.idempotencyKey);
    if (prior) {
      return prior;
    }

    const seatIds = normalizeSeatIds(input.seatIds);

    // The whole requested set's existence and availability is checked in one
    // query before any per-seat write starts (still racy against a
    // concurrent writer, by design — that's naive's whole point): a seat
    // missing from the result set is unknown, taking precedence over any
    // other seat in the same request already being booked.
    const seatRes = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM seats WHERE id = ANY($1)",
      [seatIds],
    );
    if (seatRes.rows.length !== seatIds.length) {
      return { kind: "not_found" };
    }
    if (seatRes.rows.some((seat) => seat.status !== "available")) {
      // RF2 (ADR-0031): this unlocked read, not the transaction below, is where a same-key
      // retry whose original committed after the lookup above is refused - re-read the key
      // before answering 409. (The in-transaction conflict further down cannot be spurious:
      // the same-key bookings INSERT precedes the booking_seats one, so it trips on the
      // original's key first and resolves to a replay.)
      return await replayInsteadOfConflict(client, input.idempotencyKey, { kind: "conflict" });
    }

    return await runDeadlockRetryBooking(
      client,
      input.idempotencyKey,
      async (txClient, attempt) => {
        const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
          "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
          [input.userId, input.idempotencyKey],
        );
        const booking = bookingRes.rows[0]!;

        // One batched statement, not a per-seat loop: a unique-violation on
        // any one generated row aborts the whole INSERT (no partial rows),
        // so all-or-nothing holds without needing to catch and roll back a
        // loop.
        try {
          await txClient.query(
            "INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])",
            [booking.id, seatIds],
          );
        } catch (err) {
          if (isUniqueViolation(err, "booking_seats_seat_id_key")) {
            return { kind: "conflict", retries: attempt };
          }
          throw err;
        }

        await txClient.query(
          "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = ANY($2)",
          [input.userId, seatIds],
        );

        return { kind: "created", bookingId: booking.id, createdAt: booking.created_at, retries: attempt };
      },
      (result) => result.kind === "created",
    );
  } finally {
    client.release();
  }
}
