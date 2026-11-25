import type { PoolClient } from "pg";
import { SerializationRetriesExhaustedError, pool, withSerializableTransaction } from "../db/pool.js";
import { isUniqueViolation } from "../db/pgErrors.js";
import { findPriorBookingForKey, normalizeSeatIds, resolveIdempotencyKeyRace } from "./idempotency.js";
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
//
// Multi-seat deadlock fix (Phase 3, issue #29; same phenomenon as naive's,
// unique_constraint's, and optimistic's, issues #26-#28): seat_ids is
// normalized via normalizeSeatIds (issue #31; see idempotency.ts for why not
// localeCompare) before any write. Unlike those three mechanisms, this
// mechanism doesn't gain withDeadlockRetry — its own
// withSerializableTransaction loop (ADR-0011, src/db/pool.ts) is extended
// instead to also treat a deadlock abort as retriable, using the same
// counter/cap/backoff it already applies to a genuine serialization failure
// (see that function's doc comment for why nesting withDeadlockRetry here
// would be wrong: two nested retry-from-BEGIN loops would double-BEGIN on
// every retry).
export async function bookSeatSerializable(
  input: BookSeatInput,
  options: BookSeatSerializableOptions = {},
): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const prior = await findPriorBookingForKey(client, input.idempotencyKey);
    if (prior) {
      return prior;
    }

    const seatIds = normalizeSeatIds(input.seatIds);

    try {
      return await withSerializableTransaction(
        client,
        async (txClient, attempt) => {
          // The whole requested set's existence is checked in one query
          // before any per-seat availability check or write starts: a seat
          // missing from the result set is unknown, taking precedence over
          // any other seat in the same request already being booked.
          const seatRes = await txClient.query<{ id: string; status: string }>(
            "SELECT id, status FROM seats WHERE id = ANY($1)",
            [seatIds],
          );
          if (seatRes.rows.length !== seatIds.length) {
            return { kind: "not_found" };
          }
          if (seatRes.rows.some((seat) => seat.status !== "available")) {
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
