---
status: accepted
---

# A refused claim re-reads its Idempotency Key before it is answered 409 (RF2)

Finding RF2 (issue #61, found by model checking: `formal/README.md` "Findings", invariant `KeyNeverFalselyRefused`): every booking mechanism looks the Idempotency Key up **before its transaction**. If the original attempt commits after that lookup and before the retry reaches its own conflict check, the retry sees a taken seat (or a lock the original's commit just released, or a lost compare-and-swap) and answers **409** for a request that in fact succeeded. If the original's response was also lost, 409 is the client's only answer until a *further* retry, which overlaps nothing and replays. Neither a Correctness violation nor visible to any chaos Oracle (the Booking exists exactly once; the wrong answer is an HTTP status, which ADR-0022 never treats as evidence), so it is a Robustness finding, fixed here.

## The survey: which mechanisms can answer a spurious 409

The issue named `pessimistic` and asked that every mechanism with a pre-transaction lookup be surveyed. All six have one (`findPriorBookingForKey` is each strategy's first step); what differs is what each does at its conflict check. Every row below was reproduced by a deterministic test on the real code path (staged by committing the original right after the retry's key lookup returns empty) (`runIdempotencyKeyRaceContractTests` in `test/bookingContract.ts`, run by all six strategy test files; the Hold half by `runHoldKeyRaceContractTests`), which **failed before the fix** with `409` where `201` + the original's id was expected, except `unique_constraint`, which passes before and after.

| mechanism | spurious 409 before the fix? | where | after |
|---|---|---|---|
| `pessimistic` (booking) | **yes** | `FOR UPDATE NOWAIT` succeeds once the original has committed and released its lock, `status <> 'available'` → `conflict`. Also the lock-failure half (below) | re-read, replay |
| `pessimistic` (hold, `POST /holds`) | **yes** | the same two branches in `holdSeatsPessimistic` | re-read, replay |
| `advisory` | **yes** | `pg_try_advisory_xact_lock` succeeds after the original's commit, the status read taken after the lock (ADR-0027) sees `booked` → `conflict`; and `!acquired` with the original already committed | re-read, replay |
| `naive` | **yes**, in its *unlocked* read | the plain `SELECT id, status` before the transaction returns `conflict` without ever opening one | re-read, replay |
| `optimistic` | **yes**, with the widest window | the initial `readSeats` already sees `booked`; or the CAS `UPDATE` **waits on the original's row lock**, the original commits, the CAS misses (`version` moved), the second `readSeats` shows `booked` → `conflict`. So the retry can wait for the original's commit and *still* answer 409 (this second shape follows from Postgres's row-lock semantics and ADR-0009's miss handling; the test stages the first, which ends in the same `conflict` return) | re-read, replay |
| `serializable` | **yes** | the transaction's snapshot postdates the original's commit and shows `booked` → `conflict` (also after a `40001` retry, whose fresh snapshot sees it) | re-read, replay |
| `unique_constraint` | **no, cannot** | the same-key `INSERT INTO bookings` precedes the seat claim. A committed original → unique violation → `resolveIdempotencyKeyRace` → replay; an in-flight one → the insert **waits** on its uncommitted key entry, then fails the same way. The seat claim (`booking_seats … ON CONFLICT DO NOTHING`) is never reached with a same-key original in existence. No change; the test is the record | unchanged |
| `confirm` (`POST /holds/:id/confirm`) | **no** (unchanged) | repeats its key lookup *inside* the transaction after its locks (`ConfirmNeverFalselyRefused`) | unchanged |

`naive`'s in-transaction `conflict` (the `booking_seats` unique violation) cannot be spurious for the same reason as `unique_constraint`'s: the bookings insert comes first. Only its early unlocked read needed the fix.

**RF1 neither fixes nor masks any of this.** RF1 (ADR-0030) widened the first lookup to also read tombstones and added a `BEFORE INSERT` trigger on `bookings`/`holds`. The trigger fires only for an attempt that reaches its insert; every spurious 409 above is a refusal decided *before or instead of* the insert, so the trigger never sees it. The tombstone half does not help either: a retry of an *unreleased* original has no tombstone. What RF1 does change is the answer vocabulary: a key lookup now yields a replay **or** `410 key_released`, so the fix below returns whichever it finds (a retry whose original committed and was then cancelled before the conflict check is a `410`, exactly as if the first lookup had run later). That composition is tested too.

## Decision: re-read the key once, on a fresh read, before a conflict is answered

`replayInsteadOfConflict` / `replayHoldInsteadOfConflict` (`src/strategies/idempotency.ts`): when a mechanism's attempt ends in `conflict`, run `findPriorBookingForKey` (`findPriorHoldForKey`) once more on the connection that just finished its transaction, and return what it finds (replay or `key_released`) instead of the 409. Nothing found → the 409 stands. Called by `pessimistic`, `pessimisticHold`, `advisory`, `optimistic` and `serializable` after their transaction ends, and by `naive` at its early conflict return. `X-Booking-Retries` is carried over onto the replay when the attempt had spent retries.

### Why this is correct

A refusal is only ever decided from state the original's commit had already changed. Commit visibility is monotonic and the re-read is a **new statement** (autocommit, READ COMMITTED: its snapshot is taken when it starts), so if the original's key row was committed before the refusal was observed, the re-read sees it. If the original was still in flight at the re-read it holds the seat's lock and has no committed row: 409 is right then, because the retry was concurrent with an attempt that had not succeeded, and the replay on the *next* retry is the existing, correct behavior. A **different** key wanting the same seat finds nothing under its own key and stays a 409, which the companion tests pin (including after the other key's commit inside the window). Nothing about acquisition changes: `NOWAIT` and the non-blocking advisory lock are untouched (ADR-0006), as is 404-before-409 (`not_found` is returned before and never re-read).

### Why not "repeat the lookup inside the transaction after the locks" (the confirm path's shape)

It was the issue's first candidate, and TLC refuted it as the whole fix. A retry's `NOWAIT` can also **fail** while the key's row is already committed: a concurrent Confirm of that very Hold holds the Hold's seat locks, or a losing attempt briefly row-locks a seat it will not get (O1, Exhibit G; `FOR UPDATE NOWAIT` locks the rows before the `available` check). That is a 409 with a committed key that no in-transaction lookup after a *successful* lock can reach, and the failed statement leaves the transaction aborted (25P02) so the lookup would need a second connection anyway. Candidate 2 (re-read on the conflict path only) covers both halves, and the model says so: with the re-read applied only to a refusal caused by a taken seat (`CrashRecheckTakenOnly`) `KeyNeverFalselyRefused` is still violated, in nine states, by a retry whose `NOWAIT` fails on an unrelated transaction's lock while its key is committed; the final model re-reads on **every** refusal and the property holds over all 484,716 reachable states (`NoLateReplayWhileLocked` is the vacuity guard that proves the lock-failure branch is reachable). Two further reasons for the conflict-path placement over a lookup on every attempt: it costs the *winning* path nothing, and it needs no restructuring of the three mechanisms (`naive`, `optimistic`, `serializable`) whose conflict is decided outside a lock.

The re-read runs *after* the transaction has ended, not inside it: it does not extend how long a contended seat's lock is held, and for `serializable` it stays outside SSI (no new read dependency can turn a clean 409 into a `40001`).

### Cost, measured

One extra indexed statement (`bookings.idempotency_key` / `idempotency_tombstones` primary key, one `UNION ALL`: the very query every mechanism already runs first, which ADR-0030 measured at about 2.6 µs server-side) on the **conflict path only**. A created / replayed / 404 / 503 outcome pays nothing, and so does the Hold or Booking that wins. The cost is therefore one round trip per *loser*, and `hammer-seat` (all but one request a loser) is the worst case. Measured end to end, no Fault, 100 concurrent requests at one seat, 5 repeats per report, 10 reports per cell, the parent commit and this change alternated against one Postgres (Exhibit H section M; reports in `docs/evidence/chaos/rf2-nofault/`):

| mechanism | mean p50 before → after | mean p99 before → after | throughput before → after |
|---|---|---|---|
| `pessimistic` | 41.7 → 44.3 ms (+6.2%) | 47.3 → 50.7 ms (+7.2%) | 2,409 → 2,257 req/s (−6.3%) |
| `advisory` | 31.1 → 34.6 ms (+11.3%) | 33.5 → 37.0 ms (+10.5%) | 3,193 → 2,799 req/s (−12.3%) |
| `naive` | 40.3 → 39.0 ms (−3.2%) | 43.0 → 42.0 ms (−2.4%) | 2,310 → 2,422 req/s (+4.9%) |
| `optimistic` | 49.7 → 51.1 ms (+2.9%) | 59.4 → 62.8 ms (+5.7%) | 1,712 → 1,631 req/s (−4.7%) |
| `serializable` | 43.0 → 45.1 ms (+4.8%) | 46.7 → 49.0 ms (+4.9%) | 2,102 → 2,009 req/s (−4.4%) |
| `unique_constraint` (code unchanged: the noise control) | 39.9 → 41.0 ms (+2.7%) | 42.8 → 43.5 ms (+1.5%) | 2,439 → 2,423 req/s (−0.7%) |

So the cost is real but small and only partly separable from noise: the untouched control moved +2.7% / +1.5% on its own, `naive` (whose losers do not open a transaction, so the extra statement is the smallest share of its work) moved the other way, and the two mechanisms with the shortest loser path (`advisory`: lookup, `BEGIN`, lock probe, `ROLLBACK`; `pessimistic`) show the largest, +6% to +11% on p50, in line with one more round trip on a loser path of five or six on a loopback database. Against a database that is not on loopback each round trip costs more in absolute terms and the relative share stays about the same. Nothing is slower for a winner, and no cell changed a status count (50 / 4,950 / 0 / 0 in every cell, before and after; zero double-booking). `retry_exhausted` and `not_found` paths are untouched. A conflict that finds a replay costs the same one statement and returns `201` instead of `409`.

## Consequences

- A same-key retry can no longer be told 409 once its original's key is committed, for every mechanism. The retry returns `201` with the original's id (a Hold: its id, seats and `held_until`), or `410 key_released` if the original was released first.
- A Hold's replay is, as before, whatever its expiry (O3): the new late-replay path inherits it.
- If the connection is dead when the re-read runs (a Fault that also killed the closing `ROLLBACK`, ADR-0025), the request now answers the infrastructure outcome (`502`/`504`, ADR-0025/0026) instead of a `409` it could not verify against the key; the client retries those anyway, and a `409` after a failed re-read would be exactly the unverified refusal RF2 is about.
- `retry_exhausted` (503) is deliberately not re-read: it is the "never learned whether the seat was taken" answer and the client retries it.
- The formal model gains `RecheckMode`, a `refused` step and `Recheck` action (`CrashRecovery.tla`); `CrashFindingSpuriousConflict` is now a positive check. `CrashNoRecheck` (the old behavior) is its negative control and `CrashWitnessLateReplay*` show the new answer is reachable, with the seats locked by another transaction and not.
- Still true and not addressed: `unique_constraint`'s `ON CONFLICT` waits rather than failing fast (O2); `NOWAIT` losers lock briefly (O1).
