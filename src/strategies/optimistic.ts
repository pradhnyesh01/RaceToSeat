import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { findExistingBookingByIdempotencyKey, normalizeSeatIds, runDeadlockRetryBooking } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

export interface BookSeatOptimisticOptions {
  maxRetries?: number;
}

interface SeatState {
  status: string;
  version: number;
}

// Keyed by the requested seat_id lowercased, not the DB row's own casing:
// Postgres compares uuid columns case-insensitively (WHERE id = ANY($1)
// matches regardless of how the client spelled it), but a plain JS Map
// lookup doesn't — keying by the row's canonical id and looking up with the
// client's original casing would miss whenever they differ, throwing on the
// non-null assertion where this Map is read.
function readSeats(client: PoolClient, seatIds: string[]): Promise<Map<string, SeatState>> {
  return client
    .query<SeatState & { id: string }>("SELECT id, status, version FROM seats WHERE id = ANY($1)", [seatIds])
    .then(
      (res) =>
        new Map(res.rows.map((row) => [row.id.toLowerCase(), { status: row.status, version: row.version }])),
    );
}

// ADR-0009: a CAS miss almost always means the seat is now permanently
// booked, where retrying is pointless. The one legitimate exception is a
// race with a concurrent cancellation, which also bumps `version` and
// returns the seat to 'available' — so on a miss we re-read and retry only
// if the fresh read still shows 'available'; a fresh 'booked' read is an
// ordinary conflict, resolved immediately without spending retry budget.
// Exhausting the budget on a miss (no budget left to even re-read and
// distinguish the two cases) is its own outcome (ADR-0012): the mechanism
// never learns whether the seat was genuinely taken.
//
// Multi-seat deadlock fix (Phase 3, issue #28; same phenomenon as naive's
// and unique_constraint's, issues #26/#27): seat_ids is sorted once via
// normalizeSeatIds (issue #31; see idempotency.ts for why not localeCompare).
// Unlike those two mechanisms' single batched INSERT, optimistic's per-seat
// CAS is a sequential loop of individual UPDATEs, an even more direct
// wait-for-cycle shape: two concurrent opposite-order requests for the same
// seat pair can each lock their first seat's row via their first UPDATE,
// then block on the other's UPDATE for the second. Sorting first means both
// requests always attempt the same seat in the same order, closing that
// cycle structurally; withDeadlockRetry (ADR-0014) below is the fallback
// layer for whatever ordering doesn't cover.
//
// The whole transactional attempt — including the CAS-retry loop below — is
// wrapped in withDeadlockRetry via the shared runDeadlockRetryBooking helper
// (issue #31). A deadlock abort kills the entire transaction, so a
// deadlock-triggered retry re-invokes this callback from scratch: a fresh
// BEGIN, a fresh readSeats, and the CAS loop's own `attempt` counter
// restarting at 0 — never resuming mid-loop with stale state from an aborted
// transaction (issue #28's "unaffected" requirement is about this reset
// behavior and ADR-0009's own conflict/exhaustion logic, not about hiding
// deadlock retries from the client). withDeadlockRetry's own attempt number
// (`deadlockAttempt`) is added to the CAS loop's `attempt` in every reported
// `retries` value, so X-Booking-Retries still reflects the true total retry
// cost a caller paid — a deadlock-recovered success that then won its first
// CAS attempt reports 1, not 0, matching naive's/unique_constraint's
// convention of always surfacing the deadlock-attempt count rather than
// silently absorbing it.
//
// Each attempt runs its whole per-seat CAS loop inside a SAVEPOINT: a miss
// partway through a set (seat 1 booked, seat 2 lost) must undo seat 1's
// already-applied CAS before either retrying with fresh versions or
// returning a clean conflict — a plain ROLLBACK would also discard the still-
// open transaction's earlier idempotency read, and there's no reason to
// restart the whole transaction from BEGIN (that's what deadlock recovery is
// for) just to retry this mechanism's own unrelated CAS-vs-cancellation race.
export async function bookSeatOptimistic(
  input: BookSeatInput,
  options: BookSeatOptimisticOptions = {},
): Promise<BookSeatResult> {
  const maxRetries = options.maxRetries ?? config.optimisticMaxRetries;
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    const seatIds = normalizeSeatIds(input.seatIds);

    return await runDeadlockRetryBooking(
      client,
      input.idempotencyKey,
      async (txClient, deadlockAttempt) => {
        const initialSeats = await readSeats(txClient, seatIds);
        if (initialSeats.size !== seatIds.length) {
          return { kind: "not_found" };
        }

        let seats = initialSeats;
        let attempt = 0;
        while (true) {
          await txClient.query("SAVEPOINT optimistic_attempt");

          let missedSeatId: string | undefined;
          for (const seatId of seatIds) {
            const seat = seats.get(seatId)!;
            const casRes = await txClient.query(
              "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = $2 AND version = $3 AND status = 'available'",
              [input.userId, seatId, seat.version],
            );
            if (casRes.rowCount !== 1) {
              missedSeatId = seatId;
              break;
            }
          }

          if (!missedSeatId) {
            await txClient.query("RELEASE SAVEPOINT optimistic_attempt");

            const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
              "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
              [input.userId, input.idempotencyKey],
            );
            const booking = bookingRes.rows[0]!;

            await txClient.query(
              "INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])",
              [booking.id, seatIds],
            );

            return {
              kind: "created",
              bookingId: booking.id,
              createdAt: booking.created_at,
              retries: deadlockAttempt + attempt,
            };
          }

          // All-or-nothing: undo any seat earlier in this loop that CAS'd
          // successfully in this attempt before either retrying or conflicting.
          await txClient.query("ROLLBACK TO SAVEPOINT optimistic_attempt");

          if (attempt >= maxRetries) {
            return { kind: "retry_exhausted", retries: deadlockAttempt + attempt };
          }

          seats = await readSeats(txClient, seatIds);
          if ([...seats.values()].some((seat) => seat.status !== "available")) {
            return { kind: "conflict", retries: deadlockAttempt + attempt };
          }
          attempt++;
        }
      },
      (result) => result.kind === "created",
    );
  } finally {
    client.release();
  }
}
