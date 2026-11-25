---
status: accepted
---

# The reaper's sweep skips row-locked seats instead of waiting on them

Finding R7 (issue #57, Exhibit H): `runReaperSweep` was one chained-CTE statement whose first step was a plain `UPDATE seats ... WHERE status = 'held' AND held_until < now()`. A plain `UPDATE` takes row locks as it visits rows and **waits** on a row someone else has locked, keeping every lock it had already taken. With one expired seat row-locked by a slow or leaked transaction, the statement parked on it holding locks on the other expired seats it had visited, and `POST /holds` / `POST /holds/{id}/confirm` (both `FOR UPDATE NOWAIT`, ADR-0017/0018) failed with `55P03` on those seats and answered 409 though nothing was wrong with them. And since a statement that is cancelled rolls back *all* of its work, the sweep reaped nothing at all in that time. Measured in C3 (no Fault, 12 expired seats + 3 row-locked bait seats): **0 of 12** fresh Holds won in the 3.5 s window (baseline 12 of 12), 623 × 409 (baseline 527). It healed when the lock cleared, so this is Robustness, not Correctness. A leaked lock made it indefinite until R4's `statement_timeout` (ADR-0026), which only turns "wait forever" into "wait 1.5 s, roll back everything, try again next tick, hold the same locks again".

## Decision

The sweep never waits on a row lock. A new first CTE takes the locks itself, non-blockingly:

```sql
WITH candidates AS (
  SELECT s.id, hs.hold_id
  FROM seats s LEFT JOIN hold_seats hs ON hs.seat_id = s.id
  WHERE s.status = 'held' AND s.held_until < now()
  FOR UPDATE OF s SKIP LOCKED
),
partly_locked_holds AS (
  SELECT DISTINCT sibling.hold_id
  FROM hold_seats sibling LEFT JOIN candidates locked ON locked.id = sibling.seat_id
  WHERE locked.id IS NULL AND sibling.hold_id IN (SELECT hold_id FROM candidates)
),
expired AS (
  UPDATE seats SET status = 'available', ...
  WHERE id IN (SELECT c.id FROM candidates c
               WHERE NOT EXISTS (SELECT 1 FROM partly_locked_holds p WHERE p.hold_id = c.hold_id))
    AND status = 'held' AND held_until < now()
  RETURNING id
),
deleted_hold_seats AS (DELETE FROM hold_seats WHERE seat_id IN (SELECT id FROM expired) RETURNING hold_id)
DELETE FROM holds WHERE id IN (SELECT hold_id FROM deleted_hold_seats)
```

A seat locked by anyone else (a Confirm in flight, a leaked transaction, the chaos harness's bait lock) is simply absent from `candidates` and is picked up by the next tick once its lock clears. It is still one statement, one round trip, no explicit transaction.

### What is preserved from ADR-0018 / the comment block in `src/reaper.ts`

- **No stale-id trap (EvalPlanQual).** `candidates` repeats the same `status`/`held_until` predicate, and a locking `SELECT` re-checks its `WHERE` against the latest committed row version if a racing Confirm changed the seat in between, exactly as an `UPDATE` does. The `UPDATE` keeps its *own* `status = 'held' AND held_until < now()` as the real check, so a seat that flipped to `booked` between lock and update is still skipped. `candidates` is not a precomputed id list a later statement trusts: its rows are *locked* by this statement, and the statement that mutates them re-checks them. The delete steps still take their ids from the previous CTE's `RETURNING` (rows this statement really updated), unchanged. The existing reaper-vs-Confirm race tests pass unmodified.
- **No half-reaped state.** Unchanged: seat reset, `hold_seats` delete and `holds` delete are still the same atomic statement.

### The one new hazard: multi-seat Holds, and why a Hold is reaped all-or-nothing

`SKIP LOCKED` changes which rows each later step sees, and that matters for a Hold with two seats where only one is locked. Reaping just the unlocked seat would delete its `hold_seats` row and then delete the `holds` row via `deleted_hold_seats` — but `hold_seats.hold_id` references `holds` with no `ON DELETE CASCADE` (ADR-0020), so the *whole statement would fail* on the foreign key, for as long as the lock lived: the sweep would never reap anything. (Reaping the one seat without deleting the Hold would instead strand a Hold half `available`.) So `partly_locked_holds` names every Hold with a seat that is not among this statement's locked candidates, and `expired` resets a seat only if its Hold is not in that set. A Hold with any locked or otherwise non-candidate sibling is skipped whole and waits for a later tick. All seats of a Hold share one `held_until`, so they expire together and the common case (every seat a candidate) reaps normally. A `held` seat with no `hold_seats` row (no code path produces one) has a NULL `hold_id`, matches nothing in `partly_locked_holds`, and is reaped on its own as before. `test/reaper.test.ts` covers this with a multi-seat Hold whose second seat is locked.

## Alternatives considered

- **`lock_timeout` on the sweep.** Rejected for three reasons. ADR-0026 deliberately sets none: a `lock_timeout` raises `55P03`, the code the `NOWAIT` strategies translate into 409, and `isLockNotAvailable` already has to exclude it. It would still hold the other seats' locks until it fired. And when it fired the statement would roll back all its work, so a bait that outlives the timeout (a leaked lock) would starve the reaper of *every* seat on *every* tick, the same outcome `statement_timeout` already produced.
- **`NOWAIT` in the candidate selection.** Fails the whole sweep on the first locked seat: the same starvation, trading a wait for an error.
- **Bounded batches (`LIMIT n`).** Still waits on a locked row inside the batch, so it bounds the damage by batch size without removing it, and every tick re-visits the same locked seat first.
- **A separate read of candidate ids, then a per-seat `UPDATE`.** The precomputed stale-id list ADR-0018 and the comment in `reaper.ts` rule out, and several round trips instead of one.
- **Reaping per Hold instead of per seat** (lock the `holds` rows, `SKIP LOCKED`). Confirm locks *seats*, not `holds` rows, so a lock on `holds` would not see the contention that matters.

## Consequences

- A leaked or slow lock on one expired seat no longer reaches any other seat: the 9 expired seats not under a bait lock are reaped on the first tick and won by fresh Holds in the same window (measured: 12 of 12, Exhibit H section J). The bait seats are reaped on the first tick after their lock clears.
- A sweep that collides with a Confirm on the same seat does not wait; it skips the seat for a tick. A Confirm that arrives while a sweep holds a seat's row lock still gets a brief 409 (`NOWAIT`), as before: that residue (O1 in Exhibit G, microseconds) is a conflict, not a wait, and is not what R7 was.
- Cost of the sweep when nothing is locked, `load-harness/chaos/bench-reaper-sweep.ts` (one full sweep, 25 % of Holds two-seat, medians): 200 expired seats 2 ms vs 2 ms; 2,000 expired seats 14 vs 16 ms; 20,000 expired seats 157 vs 171 ms (old vs new). The first formulation of the multi-seat guard (an inline `NOT EXISTS`/`NOT IN` over `candidates` inside the `UPDATE`'s subquery) cost +70 % at 20,000 seats, almost all of it JIT compilation triggered by the planner's inflated cost estimate for that subplan; moving it into its own CTE removed it and is why the guard is shaped this way.
- Under a Fault the sweep now almost never sits in the middle of a statement, so "a reaper sweep killed mid-flight" stops being a thing this workload can reproduce (7 and 24 before, 0 after). The deterministic tests of half-reaped shapes remain the evidence for that.
- `db/schema.sql` is untouched: the existing `seats_held_expiry_idx` still drives `candidates`.
