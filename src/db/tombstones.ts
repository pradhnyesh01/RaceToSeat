import type { Pool } from "pg";

// Idempotency-key tombstones (issue #60, finding RF1, ADR-0030): when a Booking or
// Hold row is deleted (Cancel, Confirm, reap - ADR-0020) the same statement chain
// leaves a row in idempotency_tombstones, so a retry of the key is answered "released"
// instead of being mistaken for a new attempt. The three release sites (DELETE
// /bookings/:id, confirm, the reaper) each write theirs with this one fragment, as the
// last step of the data-modifying CTE that already removes the row, so the tombstone is
// committed atomically with the removal - there is no instant at which the row is gone
// and its key is forgotten.
//
// `sourceCte` must expose (id, idempotency_key) of the rows just removed (a delete with
// RETURNING id, idempotency_key); `retentionParam` is the 1-based placeholder of the
// retention in seconds (config.idempotencyRetentionSeconds). kind/reason are fixed
// literals from the three call sites, never request data. ON CONFLICT refreshes a
// tombstone whose key was reused after its retention elapsed (expired tombstones are only
// removed by the pruner, which may not have run yet).
export function tombstoneInsertSql(args: {
  kind: "booking" | "hold";
  reason: "cancelled" | "confirmed" | "expired";
  sourceCte: string;
  retentionParam: number;
}): string {
  return `INSERT INTO idempotency_tombstones (kind, idempotency_key, resource_id, reason, expires_at)
     SELECT '${args.kind}', idempotency_key, id, '${args.reason}', now() + make_interval(secs => $${args.retentionParam})
     FROM ${args.sourceCte}
     ON CONFLICT (kind, idempotency_key) DO UPDATE
     SET resource_id = EXCLUDED.resource_id, reason = EXCLUDED.reason,
         released_at = now(), expires_at = EXCLUDED.expires_at`;
}

// Prunes tombstones past their retention. Housekeeping only: lookups and the insert
// guard already ignore an expired tombstone, so skipping or delaying this changes table
// size, not behavior. Takes its pool as an argument like runReaperSweep, so tests can
// call it directly.
export async function pruneExpiredTombstones(prunePool: Pool): Promise<number> {
  const res = await prunePool.query("DELETE FROM idempotency_tombstones WHERE expires_at <= now()");
  return res.rowCount ?? 0;
}

export interface TombstonePruner {
  stop: () => void;
}

// Runs for every BOOKING_STRATEGY (Cancel exists under all six, unlike the reaper). A
// failed prune is logged, not thrown, for the same reason the reaper's sweep is.
export function startTombstonePruner(prunePool: Pool, intervalMs: number): TombstonePruner {
  const interval = setInterval(() => {
    pruneExpiredTombstones(prunePool).catch((err: unknown) => {
      console.error("Idempotency tombstone prune failed:", err);
    });
  }, intervalMs);
  return { stop: () => clearInterval(interval) };
}
