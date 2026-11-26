import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { isLockNotAvailable } from "../db/pgErrors.js";
import {
  findPriorHoldForKey,
  normalizeSeatIds,
  replayHoldInsteadOfConflict,
  runTransactionalHold,
} from "./idempotency.js";
import type { HoldSeatsInput, HoldSeatsResult } from "./types.js";

export type { HoldSeatsResult };

// Hold acquisition for `pessimistic`, the only mechanism the hold flow is
// implemented against (ADR-0017). Mirrors bookSeatPessimistic's shape exactly
// — same FOR UPDATE NOWAIT acquisition, same not_found-before-conflict
// precedence, same lock-not-available fallback existence check — because a
// Hold needs the identical "exactly one winner" guarantee a Booking does; the
// only differences are which table gets the new row and what `seats` ends up
// looking like on success (held, not booked, with an expiry).
export async function holdSeatsPessimistic(input: HoldSeatsInput): Promise<HoldSeatsResult> {
  const client: PoolClient = await pool.connect();
  try {
    const prior = await findPriorHoldForKey(client, input.idempotencyKey);
    if (prior) {
      return prior;
    }

    // Sorted purely for cross-mechanism consistency, same as
    // bookSeatPessimistic's — not load-bearing here either, since NOWAIT
    // can't enter a wait-for cycle (ADR-0006).
    const seatIds = normalizeSeatIds(input.seatIds);

    const result = await runTransactionalHold(client, input.idempotencyKey, async (txClient) => {
      let seatRes;
      try {
        seatRes = await txClient.query<{ id: string; status: string }>(
          "SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE NOWAIT",
          [seatIds],
        );
      } catch (err) {
        if (isLockNotAvailable(err)) {
          // Same rationale as bookSeatPessimistic's identical catch: NOWAIT
          // throws before this statement's own result set (and thus the
          // not_found check below) is ever produced, so a fresh, non-locking
          // existence check preserves 404-before-409 precedence even on this
          // losing path. Run on a fresh connection, not txClient — the failed
          // statement already left this transaction aborted (25P02).
          const existsRes = await pool.query("SELECT 1 FROM seats WHERE id = ANY($1)", [seatIds]);
          if (existsRes.rowCount !== seatIds.length) {
            return { kind: "not_found" };
          }
          return { kind: "conflict" };
        }
        throw err;
      }

      if (seatRes.rows.length !== seatIds.length) {
        return { kind: "not_found" };
      }
      // 'available' is the only acceptable starting state — a seat already
      // 'held' (by another live hold) or 'booked' both fail the whole
      // request the same way, all-or-nothing across the requested set.
      if (seatRes.rows.some((seat) => seat.status !== "available")) {
        return { kind: "conflict" };
      }

      const holdRes = await txClient.query<{ id: string }>(
        "INSERT INTO holds (idempotency_key) VALUES ($1) RETURNING id",
        [input.idempotencyKey],
      );
      const holdId = holdRes.rows[0]!.id;

      await txClient.query("INSERT INTO hold_seats (hold_id, seat_id) SELECT $1, unnest($2::uuid[])", [
        holdId,
        seatIds,
      ]);

      // now() is stable for the whole transaction, so every row this UPDATE
      // touches gets the identical held_until — required for
      // findPriorHoldForKey's MIN(held_until) read to be
      // meaningful rather than an arbitrary pick among differing values.
      const updateRes = await txClient.query<{ held_until: Date }>(
        `UPDATE seats
         SET status = 'held', booked_by = $1, held_until = now() + $2::interval, version = version + 1
         WHERE id = ANY($3)
         RETURNING held_until`,
        [input.userId, `${config.holdTtlSeconds} seconds`, seatIds],
      );

      return { kind: "created", holdId, seatIds, heldUntil: updateRes.rows[0]!.held_until };
    });
    // RF2 (ADR-0031): same as bookSeatPessimistic - a conflict is re-read against the key
    // before it is answered, since the original may have committed after the lookup above.
    return await replayHoldInsteadOfConflict(client, input.idempotencyKey, result);
  } finally {
    client.release();
  }
}
