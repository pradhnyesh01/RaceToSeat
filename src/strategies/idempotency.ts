import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { isUniqueViolation } from "../db/pgErrors.js";
import type { BookSeatResult } from "./types.js";

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

// Runs `work` inside a transaction (via withTransaction), committing only on
// a genuine "created" result and rolling back a losing/unknown outcome so no
// stray locks or partial writes survive it. Also owns the fallback for every
// mechanism's shared race: two requests carrying the same idempotency_key
// both pass findExistingBookingByIdempotencyKey and both reach the insert —
// the loser hits bookings.idempotency_key's unique-violation here and
// replays what the winner created, instead of surfacing the raw constraint
// error.
export async function runTransactionalBooking(
  client: PoolClient,
  idempotencyKey: string,
  work: (client: PoolClient) => Promise<BookSeatResult>,
): Promise<BookSeatResult> {
  try {
    return await withTransaction(client, work, (result) => result.kind === "created");
  } catch (err) {
    if (isUniqueViolation(err, "bookings_idempotency_key_key")) {
      const existing = await findExistingBookingByIdempotencyKey(client, idempotencyKey);
      if (!existing) {
        throw new Error(
          `Expected a booking with idempotency_key "${idempotencyKey}" after a unique-violation, found none`,
        );
      }
      return { kind: "idempotent_replay", bookingId: existing.id, createdAt: existing.createdAt };
    }
    throw err;
  }
}
