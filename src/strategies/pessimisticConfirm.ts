import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { isLockNotAvailable } from "../db/pgErrors.js";
import { findExistingBookingByIdempotencyKey, insertBookingForSeats } from "./idempotency.js";
import type { ConfirmHoldResult } from "./types.js";

export type { ConfirmHoldResult };

// `bookings.idempotency_key` is a plain TEXT column shared with whatever
// clients pass to POST /bookings directly — prefixed so a synthesized
// confirm key can never collide with a client-supplied one (a client
// crafting/replaying idempotency_key = <some hold's raw id> could otherwise
// hijack that hold's later confirm into replaying an unrelated booking,
// leaving the real seats stuck 'held' with no path back — caught in review,
// closed here rather than relying on holds' ids being hard to guess).
// Exported so the load harness's hold-expiry pattern (issue #41) can compute
// the identical key for its own ground-truth "did a confirm succeed"
// query, instead of duplicating this string template — a drift between the
// two would silently defeat that check (an unmatched key just returns zero
// rows, not an error).
export function confirmIdempotencyKey(holdId: string): string {
  return `hold-confirm:${holdId}`;
}

// Confirms a still-live hold into a Booking, `pessimistic` only (ADR-0017,
// same scope as holdSeatsPessimistic). Confirm is bodyless, so the hold id
// (already the unique retry handle in the URL path) is what synthesizes the
// resulting booking's idempotency_key — no separate client-supplied value.
// That's also what makes a retried confirm idempotent for free:
// findExistingBookingByIdempotencyKey, keyed by confirmIdempotencyKey(holdId),
// is the exact same check every other booking mechanism already relies on.
export async function confirmHoldPessimistic(holdId: string): Promise<ConfirmHoldResult> {
  const idempotencyKey = confirmIdempotencyKey(holdId);
  const client: PoolClient = await pool.connect();
  try {
    // A fast path only, not what makes retries safe on its own — see the
    // identical check inside the transaction below, which is what actually
    // closes the race (this one alone can't: a concurrent confirm may still
    // be mid-flight, not yet committed, when this runs). Worth paying for
    // regardless: it skips opening a transaction at all for the common case
    // of a retry arriving well after the original confirm already finished.
    const existingBooking = await findExistingBookingByIdempotencyKey(client, idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    return await withTransaction(
      client,
      async (txClient) => {
        // hold_seats and seats are read and locked in one statement, not two
        // — a query is one atomic operation Postgres re-evaluates as a
        // whole against the latest committed data before returning, so
        // there's no gap for a concurrent confirm's commit to land inside,
        // the way there would be between two separate round-trip queries.
        let seatRes;
        try {
          seatRes = await txClient.query<{
            id: string;
            status: string;
            held_until: Date | null;
            booked_by: string | null;
          }>(
            `SELECT s.id, s.status, s.held_until, s.booked_by
             FROM hold_seats hs
             JOIN seats s ON s.id = hs.seat_id
             WHERE hs.hold_id = $1
             FOR UPDATE OF s NOWAIT`,
            [holdId],
          );
        } catch (err) {
          if (isLockNotAvailable(err)) {
            // A genuinely concurrent confirm on this same hold holds the
            // lock right now.
            return { kind: "conflict" };
          }
          throw err;
        }

        if (seatRes.rows.length === 0) {
          // Two ways to land here: the hold id never existed, or it was
          // already confirmed by a request whose commit fully landed before
          // this query ran at all (hold_seats rows gone by then). A
          // fallback existence check (same idiom as bookSeatPessimistic's
          // own NOWAIT-conflict fallback, which disambiguates 404-vs-409
          // the same way) tells them apart: if a booking with this
          // confirm's synthesized key exists now, replay it instead of
          // wrongly 404ing a hold that really did confirm.
          const existing = await findExistingBookingByIdempotencyKey(txClient, idempotencyKey);
          if (existing) {
            return { kind: "idempotent_replay", bookingId: existing.id, createdAt: existing.createdAt };
          }
          return { kind: "not_found" };
        }

        if (seatRes.rows.some((seat) => seat.status !== "held")) {
          // Defensive: only this function ever moves a seat still
          // referenced by hold_seats away from 'held', and always in the
          // same transaction as deleting hold_seats — so this shouldn't be
          // reachable given the combined query above, but a non-'held'
          // status here would otherwise be silently misread as "expired."
          // Same replay-or-not_found fallback as the empty-result branch.
          const existing = await findExistingBookingByIdempotencyKey(txClient, idempotencyKey);
          if (existing) {
            return { kind: "idempotent_replay", bookingId: existing.id, createdAt: existing.createdAt };
          }
          return { kind: "not_found" };
        }

        // held_until is identical across every seat in a hold (set once,
        // atomically, at hold-acquisition time — pessimisticHold.ts), so
        // checking row 0 is checking all of them.
        const heldUntil = seatRes.rows[0]!.held_until;
        if (heldUntil === null || heldUntil.getTime() <= Date.now()) {
          // Expired, whether or not the reaper has physically swept it yet
          // — this check is confirm's own lazy backstop (ADR-0018),
          // independent of reaper timing.
          return { kind: "expired" };
        }

        // The hold's own booked_by carries the identity forward into the
        // resulting booking — confirm is bodyless, so there's no other
        // source for it. Every seat in the hold shares the same booked_by
        // (set atomically alongside held_until).
        const userId = seatRes.rows[0]!.booked_by!;
        // Order doesn't matter for either the booking_seats insert or the
        // seats UPDATE's WHERE id = ANY(...) (Postgres's row-visitation
        // order there is plan-determined, not array-order-determined —
        // ADR-0016) — and unlike hold/booking creation, sorting first
        // wouldn't even be cross-mechanism-consistency-motivated, since
        // confirm is pessimistic-only (ADR-0017) with no sibling mechanism
        // to stay consistent with.
        const seatIds = seatRes.rows.map((seat) => seat.id);
        const { bookingId, createdAt } = await insertBookingForSeats(txClient, seatIds, userId, idempotencyKey);

        // Child before parent, in one round trip — hold_seats has no ON
        // DELETE CASCADE onto holds, mirroring booking_seats/bookings'
        // identical, deliberate precedent (a naive CASCADE could never also
        // perform the accompanying seat-status reset, so this codebase
        // always deletes both explicitly instead of relying on one).
        await txClient.query(
          "WITH deleted_hold_seats AS (DELETE FROM hold_seats WHERE hold_id = $1) DELETE FROM holds WHERE id = $1",
          [holdId],
        );

        return { kind: "created", bookingId, createdAt };
      },
      (result) => result.kind === "created",
    );
  } finally {
    client.release();
  }
}
