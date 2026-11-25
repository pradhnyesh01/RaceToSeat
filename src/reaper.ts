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
// One statement, not a transaction wrapper around several: each step's own
// WHERE is the real check. The `expired` CTE is an UPDATE with its own
// `WHERE status = 'held' AND held_until < now()`, so Postgres's normal
// EvalPlanQual re-check (what happens under READ COMMITTED when a row a
// statement is about to touch was concurrently modified and committed by
// someone else — a live `confirm` racing this sweep, say) re-evaluates that
// same WHERE clause against the latest committed row rather than blindly
// proceeding. Precomputing the candidate id list in an earlier read-only step
// and filtering later statements by "id IN (that list)" would lose this
// safety — the id never changes, so a row that flipped to 'booked' in the
// meantime would still match "id IN (...)" and get wrongly reset.
//
// The sweep never waits on a row lock (R7, issue #57, ADR-0029). A plain
// UPDATE blocks on a single row-locked expired seat (a slow or leaked
// transaction) while keeping the row locks it already took on every other
// expired seat it visited, so unrelated `NOWAIT` Holds/Confirms on those
// seats failed with 55P03 for as long as the one lock lived. Instead the
// `candidates` CTE takes the locks itself with FOR UPDATE SKIP LOCKED: a
// locked seat is simply left for the next tick. It repeats the same
// status/held_until predicate (a locking SELECT re-checks its WHERE against
// the latest committed row, like the UPDATE's EvalPlanQual), and the UPDATE
// keeps its own predicate as the real check, so the EvalPlanQual argument
// above is unchanged. It is not the "precomputed stale id list" trap: the
// ids are row-locked, and the UPDATE re-checks regardless.
//
// A hold is reaped all-or-nothing. hold_seats.hold_id has a foreign key to
// holds with no ON DELETE CASCADE, so if one seat of a multi-seat hold were
// skipped while its sibling was reaped, deleting the holds row would fail the
// whole statement (and a partial reap would leave a hold whose seats are
// half 'available'). A seat is therefore reset only when every seat of its
// hold is among the locked candidates; otherwise the whole hold waits for a
// later tick. All seats of a hold share one held_until, so they expire
// together. A 'held' seat with no hold_seats row (not produced by any code
// path) is still reaped on its own.
//
// Exposed as a plain function taking its pool as an argument (not importing
// the shared singleton itself) so tests can call it directly and
// deterministically — seed an expired hold, call this once, assert the
// result — instead of waiting on real wall-clock time via the setInterval
// wrapper below.
export async function runReaperSweep(sweepPool: Pool): Promise<void> {
  await sweepPool.query(
    `WITH candidates AS (
       SELECT s.id, hs.hold_id
       FROM seats s
       LEFT JOIN hold_seats hs ON hs.seat_id = s.id
       WHERE s.status = 'held' AND s.held_until < now()
       FOR UPDATE OF s SKIP LOCKED
     ),
     partly_locked_holds AS (
       SELECT DISTINCT sibling.hold_id
       FROM hold_seats sibling
       LEFT JOIN candidates locked ON locked.id = sibling.seat_id
       WHERE locked.id IS NULL
         AND sibling.hold_id IN (SELECT hold_id FROM candidates)
     ),
     expired AS (
       UPDATE seats
       SET status = 'available', booked_by = NULL, held_until = NULL, version = version + 1
       WHERE id IN (
         SELECT c.id FROM candidates c
         WHERE NOT EXISTS (SELECT 1 FROM partly_locked_holds p WHERE p.hold_id = c.hold_id)
       )
         AND status = 'held' AND held_until < now()
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
