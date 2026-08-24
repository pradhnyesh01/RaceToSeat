import type { PoolClient } from "pg";
import { DeadlockRetriesExhaustedError, withDeadlockRetry, withTransaction } from "../db/pool.js";
import { isUniqueViolation } from "../db/pgErrors.js";
import type { BookSeatResult } from "./types.js";

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
