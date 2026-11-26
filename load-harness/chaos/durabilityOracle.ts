// Oracle 5 — durability of acknowledged work (issue #51, C4, ADR-0032).
//
// The four Oracles of oracles.ts judge what is in the database. None of them
// can notice that something which *was* acknowledged is no longer there, and
// the reason is structural: when a committed Booking is lost, its seat is
// simply `available` again, which is a perfectly consistent state (Oracle 1,
// 2 and 4 pass), and the Idempotency-Key replay then books it again, which
// looks like an ordinary first booking (Oracle 3 passes). A lost commit is
// invisible to every checker that only reads the end state.
//
// What does see it is the one input the other Oracles deliberately avoid: what
// the server *told a client*. This is the single place the harness uses an
// HTTP answer as evidence, and it is a narrow, one-directional use: a `201`
// is read as a promise ("this Booking id is committed"), and the stored state
// is then asked whether the promise was kept. A `201` that the database
// contradicts is the violation; a state with no `201` behind it proves
// nothing here (the other Oracles cover that). ADR-0022's rule — never infer
// the verdict from a response — is about trusting a response to say *the
// system is fine*; here a response can only be what convicts it.
//
// It must be judged BEFORE the Idempotency-Key replay: the replay would
// re-create a lost Booking under a new id and hide it. Matching by the
// acknowledged id (not just the key) is what makes "re-created" distinguishable
// from "survived".
import type { Pool } from "pg";
import { confirmIdempotencyKey } from "../../src/strategies/pessimisticConfirm.js";
import type { OracleResult, OracleScope, OracleViolation } from "./oracles.js";

export interface AcknowledgedBooking {
  // The client's own record of the request ...
  idempotencyKey: string;
  userId: string;
  seatIds: string[];
  // ... and of the 201 it got: the id the server promised.
  bookingId: string;
}

// A Hold the server answered `201` for, and (if the client got that far) the
// Booking its Confirm answered `201` with.
export interface AcknowledgedHold {
  holdId: string;
  seatIds: string[];
  userId: string;
  // The `held_until` the 201 carried, as the server's own text.
  heldUntil: string;
  confirmedBookingId?: string;
}

const normalize = (ids: string[]): string[] => ids.map((id) => id.toLowerCase()).sort();

function result(violations: OracleViolation[]): OracleResult {
  return { oracle: 5, name: "durability of acknowledged work", passed: violations.length === 0, violations };
}

async function bookingState(db: Pool, bookingId: string) {
  const res = await db.query<{ id: string; idempotency_key: string; user_id: string; seat_ids: string[]; seats_booked: boolean[] }>(
    `SELECT b.id, b.idempotency_key, b.user_id,
            coalesce(array_agg(bs.seat_id::text) FILTER (WHERE bs.seat_id IS NOT NULL), '{}') AS seat_ids,
            coalesce(array_agg(s.status = 'booked' AND s.booked_by = b.user_id) FILTER (WHERE bs.seat_id IS NOT NULL), '{}') AS seats_booked
     FROM bookings b
     LEFT JOIN booking_seats bs ON bs.booking_id = b.id
     LEFT JOIN seats s ON s.id = bs.seat_id
     WHERE b.id = $1
     GROUP BY b.id`,
    [bookingId],
  );
  return res.rows[0];
}

// Every acknowledged Booking must be present, with the key and seats it was
// acknowledged for, its seats marked booked for its user, and exactly one
// Booking may carry its key.
export async function checkAcknowledgedBookings(db: Pool, _scope: OracleScope, acked: AcknowledgedBooking[]): Promise<OracleResult> {
  const violations: OracleViolation[] = [];
  const keyCounts = await db.query<{ idempotency_key: string; n: string }>(
    "SELECT idempotency_key, count(*) AS n FROM bookings WHERE idempotency_key = ANY($1) GROUP BY idempotency_key",
    [acked.map((a) => a.idempotencyKey)],
  );
  const perKey = new Map(keyCounts.rows.map((r) => [r.idempotency_key, Number(r.n)]));

  for (const a of acked) {
    const row = await bookingState(db, a.bookingId);
    if (!row) {
      violations.push({
        kind: "acknowledged-booking-lost",
        detail: `booking ${a.bookingId} (key ${a.idempotencyKey}) was answered 201 but no such booking exists after recovery`,
        bookingIds: [a.bookingId],
        seatIds: a.seatIds,
        idempotencyKey: a.idempotencyKey,
      });
      continue;
    }
    if (row.idempotency_key !== a.idempotencyKey) {
      violations.push({
        kind: "acknowledged-booking-wrong-key",
        detail: `booking ${a.bookingId} was acknowledged for key ${a.idempotencyKey} but is stored under ${row.idempotency_key}`,
        bookingIds: [a.bookingId],
        idempotencyKey: a.idempotencyKey,
      });
    }
    const want = normalize(a.seatIds);
    const have = normalize(row.seat_ids);
    if (want.join() !== have.join()) {
      violations.push({
        kind: "acknowledged-booking-seats-changed",
        detail: `booking ${a.bookingId} was acknowledged for ${want.length} seat(s) and holds ${have.length} after recovery`,
        bookingIds: [a.bookingId],
        seatIds: want.filter((id) => !have.includes(id)),
        idempotencyKey: a.idempotencyKey,
      });
    }
    if (row.seats_booked.some((ok) => !ok)) {
      violations.push({
        kind: "acknowledged-seat-not-booked",
        detail: `booking ${a.bookingId} exists but a seat it holds is not 'booked' for ${a.userId}`,
        bookingIds: [a.bookingId],
        idempotencyKey: a.idempotencyKey,
      });
    }
    const n = perKey.get(a.idempotencyKey) ?? 0;
    if (n > 1) {
      violations.push({
        kind: "acknowledged-key-has-multiple-bookings",
        detail: `key ${a.idempotencyKey} has ${n} bookings after recovery, but only one was acknowledged`,
        bookingIds: [a.bookingId],
        idempotencyKey: a.idempotencyKey,
      });
    }
  }
  return result(violations);
}

// The hold lifecycle. An acknowledged Hold has three legitimate fates before
// the check: still live (its hold row, hold_seats and `held` seats), confirmed
// (a Booking under its synthesized confirm key, whether or not the client saw
// that Confirm's answer), or expired and reaped (its `held_until` had passed).
// Nothing else is: a Hold that was acknowledged, is not past its expiry, and is
// neither live nor confirmed was lost. An acknowledged Confirm is a Booking
// promise like any other and must be present.
export async function checkAcknowledgedHolds(db: Pool, _scope: OracleScope, acked: AcknowledgedHold[]): Promise<OracleResult> {
  const violations: OracleViolation[] = [];
  for (const a of acked) {
    const live = await db.query<{ n: string; held: string }>(
      `SELECT (SELECT count(*) FROM holds WHERE id = $1) AS n,
              (SELECT count(*) FROM hold_seats hs JOIN seats s ON s.id = hs.seat_id WHERE hs.hold_id = $1 AND s.status = 'held') AS held`,
      [a.holdId],
    );
    const hold = Number(live.rows[0]!.n) === 1;
    const heldSeats = Number(live.rows[0]!.held);
    const booking = await db.query<{ id: string }>("SELECT id FROM bookings WHERE idempotency_key = $1", [confirmIdempotencyKey(a.holdId)]);
    const confirmed = booking.rows.length > 0;

    if (a.confirmedBookingId) {
      if (!booking.rows.some((r) => r.id === a.confirmedBookingId)) {
        violations.push({
          kind: "acknowledged-confirm-lost",
          detail: `the Confirm of hold ${a.holdId} was answered 201 with booking ${a.confirmedBookingId}, which does not exist after recovery`,
          bookingIds: [a.confirmedBookingId],
          seatIds: a.seatIds,
        });
      }
      continue;
    }
    if (hold) {
      if (heldSeats !== a.seatIds.length) {
        violations.push({
          kind: "acknowledged-hold-seats-changed",
          detail: `hold ${a.holdId} exists but ${heldSeats} of its ${a.seatIds.length} seat(s) are 'held' for it`,
          seatIds: a.seatIds,
        });
      }
      continue;
    }
    if (confirmed) continue;
    const expired = await db.query<{ expired: boolean }>("SELECT $1::timestamptz <= now() AS expired", [a.heldUntil]);
    if (!expired.rows[0]!.expired) {
      violations.push({
        kind: "acknowledged-hold-lost",
        detail: `hold ${a.holdId} was answered 201 (held until ${a.heldUntil}), is not past its expiry, and neither the hold nor a Booking from it exists after recovery`,
        seatIds: a.seatIds,
      });
    }
  }
  return result(violations);
}

export async function checkAcknowledgedDurability(
  db: Pool,
  scope: OracleScope,
  acked: { bookings?: AcknowledgedBooking[]; holds?: AcknowledgedHold[] },
): Promise<OracleResult> {
  const parts = [
    ...(acked.bookings ? (await checkAcknowledgedBookings(db, scope, acked.bookings)).violations : []),
    ...(acked.holds ? (await checkAcknowledgedHolds(db, scope, acked.holds)).violations : []),
  ];
  return result(parts);
}
