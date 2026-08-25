import type { PoolClient } from "pg";
import { DeadlockRetriesExhaustedError, withDeadlockRetry, withTransaction } from "../db/pool.js";
import { isUniqueViolation } from "../db/pgErrors.js";
import type { BookSeatResult, HoldSeatsResult } from "./types.js";

// Lowercased once, then a plain default sort — not localeCompare, whose
// collation depends on the runtime's default locale/ICU build and so isn't
// guaranteed to agree across processes. Default sort compares UTF-16 code
// units, which for hex-and-hyphen UUID strings is an unambiguous ordinal
// order every process arrives at identically. Every mechanism whose
// multi-seat write order matters (naive/unique_constraint/optimistic's
// wait-for-cycle fix, ADR-0016) or that sorts purely for cross-mechanism
// consistency (serializable) calls this before any write.
export function normalizeSeatIds(seatIds: string[]): string[] {
  return seatIds.map((seatId) => seatId.toLowerCase()).sort();
}

export interface ExistingBooking {
  id: string;
  createdAt: Date;
}

// Every mechanism calls this first, before any seat-specific logic: a retry's
// seat may no longer be 'available' (the first attempt already booked it),
// and it must still replay the original booking rather than fall through to
// a conflict (issue #4).
export async function findExistingBookingByIdempotencyKey(
  client: PoolClient,
  idempotencyKey: string,
): Promise<ExistingBooking | undefined> {
  const res = await client.query<{ id: string; created_at: Date }>(
    "SELECT id, created_at FROM bookings WHERE idempotency_key = $1",
    [idempotencyKey],
  );
  const row = res.rows[0];
  return row ? { id: row.id, createdAt: row.created_at } : undefined;
}

// The fallback for every mechanism's shared race: two requests carrying the
// same idempotency_key both pass findExistingBookingByIdempotencyKey and
// both reach the insert — the loser hits bookings.idempotency_key's
// unique-violation, caught here, and replays what the winner created instead
// of surfacing the raw constraint error. Any other error is rethrown
// unchanged. Shared by runTransactionalBooking (every plain-BEGIN mechanism)
// and the serializable strategy directly (ADR-0011's dedicated transaction
// helper means it can't funnel through runTransactionalBooking itself, but
// this race has nothing to do with isolation level or the retry loop, so
// there's no reason for it to have its own copy).
export async function resolveIdempotencyKeyRace(
  client: PoolClient,
  idempotencyKey: string,
  err: unknown,
): Promise<BookSeatResult> {
  if (!isUniqueViolation(err, "bookings_idempotency_key_key")) {
    throw err;
  }
  const existing = await findExistingBookingByIdempotencyKey(client, idempotencyKey);
  if (!existing) {
    throw new Error(
      `Expected a booking with idempotency_key "${idempotencyKey}" after a unique-violation, found none`,
    );
  }
  return { kind: "idempotent_replay", bookingId: existing.id, createdAt: existing.createdAt };
}

// Runs `work` inside a transaction (via withTransaction), committing only on
// a genuine "created" result and rolling back a losing/unknown outcome so no
// stray locks or partial writes survive it.
export async function runTransactionalBooking(
  client: PoolClient,
  idempotencyKey: string,
  work: (client: PoolClient) => Promise<BookSeatResult>,
): Promise<BookSeatResult> {
  try {
    return await withTransaction(client, work, (result) => result.kind === "created");
  } catch (err) {
    return await resolveIdempotencyKeyRace(client, idempotencyKey, err);
  }
}

// The deadlock-retry counterpart to runTransactionalBooking (ADR-0014):
// naive, unique_constraint, and optimistic each wrap their transactional
// attempt in withDeadlockRetry and need the identical fallback shape — a
// DeadlockRetriesExhaustedError maps to retry_exhausted (ADR-0015), any other
// error falls through to the same idempotency-key-race check every mechanism
// shares. Not used by serializable, which extends its own
// withSerializableTransaction retry loop instead of nesting withDeadlockRetry
// (see that function's doc comment in db/pool.ts for why), or by pessimistic/
// advisory, whose non-blocking lock acquisition can't deadlock at all
// (ADR-0006).
export async function runDeadlockRetryBooking(
  client: PoolClient,
  idempotencyKey: string,
  work: (client: PoolClient, attempt: number) => Promise<BookSeatResult>,
  shouldCommit: (result: BookSeatResult) => boolean,
): Promise<BookSeatResult> {
  try {
    return await withDeadlockRetry(client, work, shouldCommit);
  } catch (err) {
    if (err instanceof DeadlockRetriesExhaustedError) {
      return { kind: "retry_exhausted", retries: err.retries };
    }
    return await resolveIdempotencyKeyRace(client, idempotencyKey, err);
  }
}

export interface ExistingHold {
  id: string;
  seatIds: string[];
  heldUntil: Date;
}

// Hold's counterpart to findExistingBookingByIdempotencyKey. Unlike a
// booking, a hold has no data of its own worth returning beyond its id — the
// seat set and expiry both live on other tables (hold_seats, seats — ADR-
// 0018/0020) — so this joins across both rather than reading the `holds` row
// alone. held_until is identical across every seat in the same hold (all
// updated from one `now() + interval` evaluated once per acquisition
// transaction), so MIN(s.held_until) is just "the value," not an aggregate
// choice among differing ones.
export async function findExistingHoldByIdempotencyKey(
  client: PoolClient,
  idempotencyKey: string,
): Promise<ExistingHold | undefined> {
  const res = await client.query<{ id: string; seat_ids: string[]; held_until: Date }>(
    `SELECT h.id, array_agg(hs.seat_id ORDER BY hs.seat_id) AS seat_ids, MIN(s.held_until) AS held_until
     FROM holds h
     JOIN hold_seats hs ON hs.hold_id = h.id
     JOIN seats s ON s.id = hs.seat_id
     WHERE h.idempotency_key = $1
     GROUP BY h.id`,
    [idempotencyKey],
  );
  const row = res.rows[0];
  return row ? { id: row.id, seatIds: row.seat_ids, heldUntil: row.held_until } : undefined;
}

// Hold's counterpart to resolveIdempotencyKeyRace, against holds' own unique
// constraint rather than bookings'.
export async function resolveHoldIdempotencyKeyRace(
  client: PoolClient,
  idempotencyKey: string,
  err: unknown,
): Promise<HoldSeatsResult> {
  if (!isUniqueViolation(err, "holds_idempotency_key_key")) {
    throw err;
  }
  const existing = await findExistingHoldByIdempotencyKey(client, idempotencyKey);
  if (!existing) {
    throw new Error(`Expected a hold with idempotency_key "${idempotencyKey}" after a unique-violation, found none`);
  }
  return { kind: "idempotent_replay", holdId: existing.id, seatIds: existing.seatIds, heldUntil: existing.heldUntil };
}

// Hold's counterpart to runTransactionalBooking. No deadlock-retry variant
// exists for holds (ADR-0017/issue #38's scope): pessimistic's NOWAIT
// acquisition can't deadlock (ADR-0006), and sorting seat_ids once before
// acquisition (done by every hold caller, mirroring the other mechanisms'
// consistency-only sort) is enough on its own.
export async function runTransactionalHold(
  client: PoolClient,
  idempotencyKey: string,
  work: (client: PoolClient) => Promise<HoldSeatsResult>,
): Promise<HoldSeatsResult> {
  try {
    return await withTransaction(client, work, (result) => result.kind === "created");
  } catch (err) {
    return await resolveHoldIdempotencyKeyRace(client, idempotencyKey, err);
  }
}

// Shared booking-creation tail (issue #39's acceptance criterion): insert
// bookings + booking_seats, then flip every named seat to 'booked'. Used by
// a direct booking (pessimistic.ts, seats start 'available') and by
// confirming a hold (pessimisticConfirm.ts, seats start 'held') alike — the
// only difference between those two callers is what state seatIds started
// in, already checked before either one calls this. `held_until = NULL` is
// unconditional rather than confirm-only: a no-op for the already-NULL
// direct-booking case, but it keeps "status = 'booked' implies held_until IS
// NULL" a mechanism-wide invariant instead of something only confirm's
// caller has to remember to clear.
export async function insertBookingForSeats(
  txClient: PoolClient,
  seatIds: string[],
  userId: string,
  idempotencyKey: string,
): Promise<{ bookingId: string; createdAt: Date }> {
  const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
    "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
    [userId, idempotencyKey],
  );
  const booking = bookingRes.rows[0]!;

  await txClient.query("INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])", [
    booking.id,
    seatIds,
  ]);
  await txClient.query(
    "UPDATE seats SET status = 'booked', booked_by = $1, held_until = NULL, version = version + 1 WHERE id = ANY($2)",
    [userId, seatIds],
  );

  return { bookingId: booking.id, createdAt: booking.created_at };
}
