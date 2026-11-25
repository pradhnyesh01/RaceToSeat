// The four chaos Oracles (issue #44, ADR-0022). Each decides, from stored
// Seat/Booking/Hold state alone, whether a chaos run violated a guarantee —
// never from HTTP responses, which a Fault can make misleading (a 500 can
// hide a committed write; a 201 can be lost in flight). A non-empty
// `violations` list from any Oracle is a Correctness violation
// (CONTEXT.md): the only outcome that fails Phase 6.
//
// Every query is scoped to one event (and, where a Booking row has no event
// link of its own, to the Idempotency Keys the harness issued) so a run can
// be judged without being polluted by leftover rows from earlier runs
// sharing the same database.
//
// Each Oracle is a separate exported function so its negative control — a
// unit test running it against a hand-corrupted database (ADR-0023,
// test/chaos/oracles.test.ts) — can target exactly one in isolation.
import type { Pool } from "pg";

// A client-side record of what one request intended: the harness knows each
// request's Idempotency Key and requested seat set, the database does not
// (a torn Booking is only detectable as "torn" relative to what was asked).
export interface BookingIntent {
  idempotencyKey: string;
  seatIds: string[];
}

export interface OracleViolation {
  kind: string;
  detail: string;
  seatIds?: string[];
  bookingIds?: string[];
  idempotencyKey?: string;
}

export interface OracleResult {
  oracle: 1 | 2 | 3 | 4;
  name: string;
  passed: boolean;
  violations: OracleViolation[];
}

export interface OracleScope {
  eventId: string;
}

// Same lowercase-then-default-sort normalization the strategies use
// (src/strategies/idempotency.ts normalizeSeatIds) — duplicated here as a
// 1-liner rather than imported, so the checker has no code path shared with
// the code it judges.
function normalize(seatIds: string[]): string[] {
  return seatIds.map((id) => id.toLowerCase()).sort();
}

function result(oracle: 1 | 2 | 3 | 4, name: string, violations: OracleViolation[]): OracleResult {
  return { oracle, name, passed: violations.length === 0, violations };
}

// Oracle 1 — mutual exclusion: no Seat is claimed by more than one Booking
// or Hold (or by a Booking and a Hold at once), and `seats` agrees with the
// claim rows about who owns it.
export async function checkMutualExclusion(db: Pool, scope: OracleScope): Promise<OracleResult> {
  const violations: OracleViolation[] = [];

  const multiBooked = await db.query<{ seat_id: string; booking_ids: string[] }>(
    `SELECT bs.seat_id, array_agg(bs.booking_id::text ORDER BY bs.booking_id) AS booking_ids
     FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id
     WHERE s.event_id = $1
     GROUP BY bs.seat_id HAVING count(*) > 1`,
    [scope.eventId],
  );
  for (const row of multiBooked.rows) {
    violations.push({
      kind: "seat-in-multiple-bookings",
      detail: `seat ${row.seat_id} is claimed by ${row.booking_ids.length} bookings`,
      seatIds: [row.seat_id],
      bookingIds: row.booking_ids,
    });
  }

  const multiHeld = await db.query<{ seat_id: string; hold_ids: string[] }>(
    `SELECT hs.seat_id, array_agg(hs.hold_id::text ORDER BY hs.hold_id) AS hold_ids
     FROM hold_seats hs JOIN seats s ON s.id = hs.seat_id
     WHERE s.event_id = $1
     GROUP BY hs.seat_id HAVING count(*) > 1`,
    [scope.eventId],
  );
  for (const row of multiHeld.rows) {
    violations.push({
      kind: "seat-in-multiple-holds",
      detail: `seat ${row.seat_id} is claimed by ${row.hold_ids.length} holds`,
      seatIds: [row.seat_id],
    });
  }

  const bookedAndHeld = await db.query<{ seat_id: string }>(
    `SELECT DISTINCT bs.seat_id
     FROM booking_seats bs
     JOIN hold_seats hs ON hs.seat_id = bs.seat_id
     JOIN seats s ON s.id = bs.seat_id
     WHERE s.event_id = $1`,
    [scope.eventId],
  );
  for (const row of bookedAndHeld.rows) {
    violations.push({
      kind: "seat-booked-and-held",
      detail: `seat ${row.seat_id} is claimed by both a booking and a hold`,
      seatIds: [row.seat_id],
    });
  }

  // `seats` must agree with the claim rows. Checked per claimed seat so a
  // double-claimed seat also surfaces any disagreement, not just the count.
  const bookedNotMarked = await db.query<{ seat_id: string; status: string }>(
    `SELECT DISTINCT s.id AS seat_id, s.status
     FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id
     WHERE s.event_id = $1 AND s.status <> 'booked'`,
    [scope.eventId],
  );
  for (const row of bookedNotMarked.rows) {
    violations.push({
      kind: "booking-claim-but-seat-not-booked",
      detail: `seat ${row.seat_id} has a booking claim but seats.status is '${row.status}'`,
      seatIds: [row.seat_id],
    });
  }

  const heldNotMarked = await db.query<{ seat_id: string; status: string }>(
    `SELECT DISTINCT s.id AS seat_id, s.status
     FROM hold_seats hs JOIN seats s ON s.id = hs.seat_id
     WHERE s.event_id = $1 AND s.status <> 'held'`,
    [scope.eventId],
  );
  for (const row of heldNotMarked.rows) {
    violations.push({
      kind: "hold-claim-but-seat-not-held",
      detail: `seat ${row.seat_id} has a hold claim but seats.status is '${row.status}'`,
      seatIds: [row.seat_id],
    });
  }

  // booked_by is only checked for a seat with exactly one claiming booking:
  // with two, "which one should booked_by match" has no answer, and the
  // multi-booking violation above already reports that seat.
  const ownerMismatch = await db.query<{ seat_id: string; booked_by: string | null; user_id: string }>(
    `SELECT s.id AS seat_id, s.booked_by, b.user_id
     FROM seats s
     JOIN booking_seats bs ON bs.seat_id = s.id
     JOIN bookings b ON b.id = bs.booking_id
     WHERE s.event_id = $1
       AND s.status = 'booked'
       AND s.booked_by IS DISTINCT FROM b.user_id
       AND (SELECT count(*) FROM booking_seats x WHERE x.seat_id = s.id) = 1`,
    [scope.eventId],
  );
  for (const row of ownerMismatch.rows) {
    violations.push({
      kind: "seat-owner-disagrees-with-booking",
      detail: `seat ${row.seat_id} booked_by=${row.booked_by} but its booking belongs to ${row.user_id}`,
      seatIds: [row.seat_id],
    });
  }

  return result(1, "mutual exclusion", violations);
}

// Oracle 2 — no torn state: every Booking holds exactly the seats it
// requested (all or nothing, ADR-0005's multi-seat atomicity), and no Seat
// is `booked` without a Booking behind it.
export async function checkNoTornState(db: Pool, scope: OracleScope, ledger: BookingIntent[]): Promise<OracleResult> {
  const violations: OracleViolation[] = [];

  const intentByKey = new Map(ledger.map((intent) => [intent.idempotencyKey, normalize(intent.seatIds)]));
  const actual = await db.query<{ id: string; idempotency_key: string; seat_ids: string[] }>(
    `SELECT b.id, b.idempotency_key,
            coalesce(array_agg(bs.seat_id::text) FILTER (WHERE bs.seat_id IS NOT NULL), '{}') AS seat_ids
     FROM bookings b LEFT JOIN booking_seats bs ON bs.booking_id = b.id
     WHERE b.idempotency_key = ANY($1)
     GROUP BY b.id`,
    [[...intentByKey.keys()]],
  );
  for (const row of actual.rows) {
    const requested = intentByKey.get(row.idempotency_key)!;
    const held = normalize(row.seat_ids);
    const missing = requested.filter((id) => !held.includes(id));
    const extra = held.filter((id) => !requested.includes(id));
    if (missing.length > 0) {
      violations.push({
        kind: "booking-missing-requested-seats",
        detail: `booking ${row.id} requested ${requested.length} seat(s) but holds ${held.length - extra.length}; missing ${missing.join(", ")}`,
        seatIds: missing,
        bookingIds: [row.id],
        idempotencyKey: row.idempotency_key,
      });
    }
    if (extra.length > 0) {
      violations.push({
        kind: "booking-has-unrequested-seats",
        detail: `booking ${row.id} holds seat(s) it never requested: ${extra.join(", ")}`,
        seatIds: extra,
        bookingIds: [row.id],
        idempotencyKey: row.idempotency_key,
      });
    }
  }

  const orphanBooked = await db.query<{ id: string }>(
    `SELECT s.id FROM seats s
     WHERE s.event_id = $1 AND s.status = 'booked'
       AND NOT EXISTS (SELECT 1 FROM booking_seats bs WHERE bs.seat_id = s.id)`,
    [scope.eventId],
  );
  for (const row of orphanBooked.rows) {
    violations.push({
      kind: "booked-seat-without-booking",
      detail: `seat ${row.id} is 'booked' but no booking claims it`,
      seatIds: [row.id],
    });
  }

  return result(2, "no torn state", violations);
}

export interface BookingsByKey {
  [idempotencyKey: string]: { bookingId: string; seatIds: string[] }[];
}

// Snapshot of which Bookings exist for each Idempotency Key, taken BEFORE
// the recovery replay so Oracle 3 can tell "the replay found the original"
// from "the replay made a new one".
export async function snapshotBookingsByKey(db: Pool, keys: string[]): Promise<BookingsByKey> {
  const res = await db.query<{ idempotency_key: string; id: string; seat_ids: string[] }>(
    `SELECT b.idempotency_key, b.id,
            coalesce(array_agg(bs.seat_id::text) FILTER (WHERE bs.seat_id IS NOT NULL), '{}') AS seat_ids
     FROM bookings b LEFT JOIN booking_seats bs ON bs.booking_id = b.id
     WHERE b.idempotency_key = ANY($1)
     GROUP BY b.id`,
    [keys],
  );
  const snapshot: BookingsByKey = {};
  for (const row of res.rows) {
    (snapshot[row.idempotency_key] ??= []).push({ bookingId: row.id, seatIds: normalize(row.seat_ids) });
  }
  return snapshot;
}

// Oracle 3 — idempotent recovery: after the Fault clears and every
// Idempotency Key is re-sent (the caller's job — this only reads state),
// no key has more than one Booking, and a key that already had a Booking
// before the replay still has exactly that one, unchanged. A key that had
// none may now have at most one (its first attempt never committed, so the
// replay legitimately created it) — "exactly one" is not required of a key
// whose seat was genuinely lost to another request.
export async function checkIdempotentRecovery(
  db: Pool,
  ledger: BookingIntent[],
  before: BookingsByKey,
): Promise<OracleResult> {
  const violations: OracleViolation[] = [];
  const keys = ledger.map((intent) => intent.idempotencyKey);
  const after = await snapshotBookingsByKey(db, keys);

  for (const key of keys) {
    const afterRows = after[key] ?? [];
    const beforeRows = before[key] ?? [];
    if (afterRows.length > 1) {
      violations.push({
        kind: "idempotency-key-produced-multiple-bookings",
        detail: `key ${key} has ${afterRows.length} bookings after recovery`,
        bookingIds: afterRows.map((row) => row.bookingId),
        idempotencyKey: key,
      });
      continue;
    }
    if (beforeRows.length === 0) {
      continue;
    }
    const original = beforeRows[0]!;
    const now = afterRows[0];
    if (!now || now.bookingId !== original.bookingId || now.seatIds.join() !== original.seatIds.join()) {
      violations.push({
        kind: "replay-changed-existing-booking",
        detail: `key ${key}'s booking ${original.bookingId} was ${now ? `replaced by/altered into ${now.bookingId}` : "removed"} by the replay`,
        bookingIds: now ? [original.bookingId, now.bookingId] : [original.bookingId],
        idempotencyKey: key,
      });
    }
  }

  return result(3, "idempotent recovery", violations);
}

export interface LivenessOptions {
  // A 'held' seat whose held_until is further in the past than this is
  // "expired but never reaped". Zero is not safe by default: the reaper
  // sweeps on an interval (config.reaperIntervalMs), so a seat can
  // legitimately sit just-expired for up to one tick.
  expiredHoldGraceSeconds?: number;
}

// Oracle 4 — liveness: once the Fault is gone and the system has had time to
// settle, no Seat is stuck. Three ways a seat can be stuck: marked 'held'
// with no Hold behind it, 'held' past its expiry with the reaper never
// having released it, or still row-locked by a transaction that never ended
// (a leaked connection or a hung request). The lock probe is a genuine
// SKIP LOCKED read inside a rolled-back transaction: any seat of the event
// it can't see is locked right now.
export async function checkLiveness(
  db: Pool,
  scope: OracleScope,
  options: LivenessOptions = {},
): Promise<OracleResult> {
  const violations: OracleViolation[] = [];
  const graceSeconds = options.expiredHoldGraceSeconds ?? 10;

  const heldWithoutHold = await db.query<{ id: string }>(
    `SELECT s.id FROM seats s
     WHERE s.event_id = $1 AND s.status = 'held'
       AND NOT EXISTS (SELECT 1 FROM hold_seats hs WHERE hs.seat_id = s.id)`,
    [scope.eventId],
  );
  for (const row of heldWithoutHold.rows) {
    violations.push({
      kind: "held-seat-without-hold",
      detail: `seat ${row.id} is 'held' but no hold claims it`,
      seatIds: [row.id],
    });
  }

  const expiredUnreaped = await db.query<{ id: string }>(
    `SELECT s.id FROM seats s
     WHERE s.event_id = $1 AND s.status = 'held'
       AND s.held_until < now() - make_interval(secs => $2)`,
    [scope.eventId, graceSeconds],
  );
  for (const row of expiredUnreaped.rows) {
    violations.push({
      kind: "expired-hold-not-reaped",
      detail: `seat ${row.id} is 'held' past its expiry (+${graceSeconds}s grace) and was never released`,
      seatIds: [row.id],
    });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const total = await client.query<{ n: string }>("SELECT count(*) AS n FROM seats WHERE event_id = $1", [scope.eventId]);
    const lockable = await client.query<{ id: string }>(
      "SELECT id FROM seats WHERE event_id = $1 FOR UPDATE SKIP LOCKED",
      [scope.eventId],
    );
    const lockableIds = new Set(lockable.rows.map((row) => row.id));
    if (lockable.rows.length !== Number(total.rows[0]!.n)) {
      const all = await client.query<{ id: string }>("SELECT id FROM seats WHERE event_id = $1", [scope.eventId]);
      const stuck = all.rows.map((row) => row.id).filter((id) => !lockableIds.has(id));
      for (const id of stuck) {
        violations.push({
          kind: "seat-row-locked-after-recovery",
          detail: `seat ${id} is still row-locked by another transaction after recovery`,
          seatIds: [id],
        });
      }
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }

  return result(4, "liveness", violations);
}

export interface RunOraclesInput {
  scope: OracleScope;
  ledger: BookingIntent[];
  before: BookingsByKey;
  liveness?: LivenessOptions;
}

export async function runOracles(db: Pool, input: RunOraclesInput): Promise<OracleResult[]> {
  return [
    await checkMutualExclusion(db, input.scope),
    await checkNoTornState(db, input.scope, input.ledger),
    await checkIdempotentRecovery(db, input.ledger, input.before),
    await checkLiveness(db, input.scope, input.liveness),
  ];
}
