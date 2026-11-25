import type { Pool } from "pg";
import { config } from "./config.js";
import { tombstoneInsertSql } from "./db/tombstones.js";

// The automatic counterpart to confirm's own lazy expiry check (ADR-0018):
// releases every expired hold's seat(s) back to `available` and deletes the
// corresponding hold_seats/holds rows, proving "no permanently stuck seats"
// (issue #40) independent of whether confirm is ever called on a given
// hold. Postgres-only — no Redis or other second stateful dependency
// (ADR-0018).
//
// One statement, not a transaction wrapper around several: the `expired`
// CTE *is* a plain UPDATE with its own `WHERE status = 'held' AND
// held_until < now()`, so Postgres's normal EvalPlanQual re-check (what
// happens under READ COMMITTED when a row a statement is about to touch was
// concurrently modified and committed by someone else — a live `confirm`
// racing this sweep, say) re-evaluates that same WHERE clause against the
// latest committed row rather than blindly proceeding. Precomputing the
// candidate id list in an earlier read-only step and filtering later
// statements by "id IN (that list)" would lose this safety — the id never
// changes, so a row that flipped to 'booked' in the meantime would still
// match "id IN (...)" and get wrongly reset. Chaining CTEs so each step's
// own predicate is the real check avoids that trap, and gets the whole
// sweep — reset seats, delete hold_seats, delete holds (child before
// parent, no ON DELETE CASCADE, same precedent as confirm's own teardown)
// — into one round trip and one atomic statement, with no explicit
// BEGIN/COMMIT needed.
//
// Exposed as a plain function taking its pool as an argument (not importing
// the shared singleton itself) so tests can call it directly and
// deterministically — seed an expired hold, call this once, assert the
// result — instead of waiting on real wall-clock time via the setInterval
// wrapper below.
export async function runReaperSweep(sweepPool: Pool): Promise<void> {
  await sweepPool.query(
    `WITH expired AS (
       UPDATE seats
       SET status = 'available', booked_by = NULL, held_until = NULL, version = version + 1
       WHERE status = 'held' AND held_until < now()
       RETURNING id
     ),
     deleted_hold_seats AS (
       DELETE FROM hold_seats WHERE seat_id IN (SELECT id FROM expired) RETURNING hold_id
     ),
     deleted_holds AS (
       DELETE FROM holds WHERE id IN (SELECT hold_id FROM deleted_hold_seats) RETURNING id, idempotency_key
     )
     ${tombstoneInsertSql({ kind: "hold", reason: "expired", sourceCte: "deleted_holds", retentionParam: 1 })}`,
    [config.idempotencyRetentionSeconds],
  );
}

export interface Reaper {
  stop: () => void;
}

// Wraps runReaperSweep in a setInterval, started at process boot only when
// BOOKING_STRATEGY=pessimistic (gated at the call site in server.ts,
// mirroring app.ts's identical gating of the hold routes — ADR-0019) and
// stopped gracefully on process shutdown. A sweep failure is logged, not
// thrown — an uncaught rejection inside a setInterval callback would
// otherwise crash the whole process over one transient DB error, taking
// down request-serving along with it for a background task that will
// simply retry on its own next tick.
export function startReaper(sweepPool: Pool, intervalMs: number): Reaper {
  const interval = setInterval(() => {
    runReaperSweep(sweepPool).catch((err: unknown) => {
      console.error("Reaper sweep failed:", err);
    });
  }, intervalMs);

  return {
    stop: () => clearInterval(interval),
  };
}
