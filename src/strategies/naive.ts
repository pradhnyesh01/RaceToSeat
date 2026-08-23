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
//
// Multi-seat (Phase 3, issue #24): seat_ids is iterated in request order, not
// sorted — ADR-0016's deliberate unordered "before" baseline for the
// deadlock-harness ticket, which fixes this with consistent ordering. No
// deadlock-retry wiring here either; that's the same follow-up ticket's job.
export async function bookSeatNaive(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    // The whole requested set's existence and availability is checked in one
    // query before any per-seat write starts (still racy against a
    // concurrent writer, by design — that's naive's whole point): a seat
    // missing from the result set is unknown, taking precedence over any
    // other seat in the same request already being booked.
    const seatRes = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM seats WHERE id = ANY($1)",
      [input.seatIds],
    );
    if (seatRes.rows.length !== input.seatIds.length) {
      return { kind: "not_found" };
    }
    if (seatRes.rows.some((seat) => seat.status !== "available")) {
      return { kind: "conflict" };
    }

    return await runTransactionalBooking(client, input.idempotencyKey, async (txClient) => {
      const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
        "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
        [input.userId, input.idempotencyKey],
      );
      const booking = bookingRes.rows[0]!;

      // One batched statement, not a per-seat loop: a unique-violation on any
      // one generated row aborts the whole INSERT (no partial rows), so
      // all-or-nothing holds without needing to catch and roll back a loop.
      try {
        await txClient.query(
          "INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])",
          [booking.id, input.seatIds],
        );
      } catch (err) {
        if (isUniqueViolation(err, "booking_seats_seat_id_key")) {
          return { kind: "conflict" };
        }
        throw err;
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
