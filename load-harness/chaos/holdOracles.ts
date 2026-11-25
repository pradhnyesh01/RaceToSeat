// Hold-lifecycle extensions of the chaos Oracles (issue #50, ADR-0022).
//
// The four Oracles in oracles.ts already cover three of the Hold guarantees
// this ticket needs, unchanged: Oracle 1 flags a Seat claimed by both a
// Booking and a Hold (and a Hold claim whose seat isn't `held`), Oracle 3
// flags a Confirm key (`hold-confirm:<id>`, the synthesized Idempotency Key
// confirm gives its Booking) with more than one Booking or whose Booking the
// replay changed, and Oracle 4 flags a Seat still `held` past its expiry plus
// a grace period. What a Hold adds that those can't see is two statements
// about *time* and *certainty*, kept here as extensions of Oracles 2 and 3
// rather than new Oracles — they are the same ground-truth-from-stored-state
// idea, and ADR-0022 names exactly four:
//
//   - Oracle 2 extension: no Booking born from a Hold that had already
//     expired. Holds and their `held_until` are deleted on resolution
//     (ADR-0020), so the harness snapshots each Hold's expiry from the
//     database right after seeding (before any Fault) and the Oracle compares
//     it with `bookings.created_at` (the confirm transaction's start time,
//     which is <= the instant confirm's own expiry check ran — so a Booking
//     that confirm correctly accepted can never look "late": no false
//     positives).
//   - Oracle 3 extension: a Confirm retried after an Ambiguous outcome yields
//     EXACTLY one Booking when the Hold was provably still live. The base
//     Oracle 3 only demands "at most one" (a lost seat may legitimately have
//     none); a live Hold has no excuse to end without a Booking once the
//     Fault is gone and its Confirm was retried.
//
// Everything is read from stored state; the only HTTP-derived input is the
// harness's list of which Holds it re-sent Confirm for (an action, not
// evidence — same stance as oracles.ts's replay).
import type { Pool } from "pg";
import { confirmIdempotencyKey } from "../../src/strategies/pessimisticConfirm.js";
import type { BookingIntent, OracleResult, OracleViolation } from "./oracles.js";

// One seeded Hold, as the database recorded it before any Fault was injected.
export interface HoldRecord {
  holdId: string;
  seatIds: string[];
  userId: string;
  // seats.held_until, kept as Postgres's own text (microsecond precision —
  // a JS Date would truncate to ms and could flip a same-millisecond
  // comparison) plus epoch milliseconds for the harness's own waiting.
  heldUntilText: string;
  heldUntilMs: number;
}

// The Booking each Hold's Confirm would create, as the intent ledger the
// base Oracles (2: atomicity, 3: idempotent recovery) judge it against: the
// Booking's key is the synthesized confirm key and its seats are the Hold's.
export function confirmIntents(holds: HoldRecord[]): BookingIntent[] {
  return holds.map((hold) => ({ idempotencyKey: confirmIdempotencyKey(hold.holdId), seatIds: hold.seatIds }));
}

function result(oracle: 2 | 3, name: string, violations: OracleViolation[]): OracleResult {
  return { oracle, name, passed: violations.length === 0, violations };
}

// Oracle 2 extension — no confirmed-after-expiry Booking.
export async function checkNoConfirmAfterExpiry(db: Pool, holds: HoldRecord[]): Promise<OracleResult> {
  const violations: OracleViolation[] = [];
  if (holds.length > 0) {
    const late = await db.query<{ id: string; idempotency_key: string; created_at: string; held_until: string }>(
      `SELECT b.id, b.idempotency_key, b.created_at::text AS created_at, h.held_until::text AS held_until
       FROM unnest($1::text[], $2::timestamptz[]) AS h(key, held_until)
       JOIN bookings b ON b.idempotency_key = h.key
       WHERE b.created_at >= h.held_until`,
      [holds.map((h) => confirmIdempotencyKey(h.holdId)), holds.map((h) => h.heldUntilText)],
    );
    for (const row of late.rows) {
      violations.push({
        kind: "booking-confirmed-after-hold-expiry",
        detail: `booking ${row.id} (${row.idempotency_key}) was created at ${row.created_at}, at/after its hold's expiry ${row.held_until}`,
        bookingIds: [row.id],
        idempotencyKey: row.idempotency_key,
      });
    }
  }
  return result(2, "no torn state: no Booking from an expired Hold", violations);
}

// Oracle 3 extension — a retried Confirm on a still-live Hold yields exactly
// one Booking. `mustHaveBooking` is the harness's list of Holds it knows were
// (a) still live (held_until in the future) when the retried Confirm was
// answered and (b) actually answered by the app (a retry the app never
// answered proves nothing about the system — that is a Robustness matter).
export async function checkLiveConfirmYieldsOneBooking(
  db: Pool,
  holds: HoldRecord[],
  mustHaveBooking: string[],
): Promise<OracleResult> {
  const violations: OracleViolation[] = [];
  const wanted = new Set(mustHaveBooking);
  const keyed = holds.filter((h) => wanted.has(h.holdId)).map((h) => ({ hold: h, key: confirmIdempotencyKey(h.holdId) }));
  if (keyed.length > 0) {
    const counts = await db.query<{ idempotency_key: string; n: string; ids: string[] }>(
      `SELECT b.idempotency_key, count(*) AS n, array_agg(b.id::text) AS ids
       FROM bookings b WHERE b.idempotency_key = ANY($1) GROUP BY b.idempotency_key`,
      [keyed.map((k) => k.key)],
    );
    const byKey = new Map(counts.rows.map((r) => [r.idempotency_key, r]));
    for (const { hold, key } of keyed) {
      const row = byKey.get(key);
      const n = row ? Number(row.n) : 0;
      if (n === 1) continue;
      violations.push({
        kind: n === 0 ? "live-hold-confirm-retry-yielded-no-booking" : "live-hold-confirm-retry-yielded-multiple-bookings",
        detail:
          n === 0
            ? `hold ${hold.holdId} was still live when its confirm was retried after the Fault cleared, yet has no booking`
            : `hold ${hold.holdId}'s confirm retry left ${n} bookings for key ${key}`,
        seatIds: hold.seatIds,
        bookingIds: row?.ids,
        idempotencyKey: key,
      });
    }
  }
  return result(3, "idempotent recovery: a live Hold's retried Confirm yields exactly one Booking", violations);
}
