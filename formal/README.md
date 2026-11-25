# formal/ — TLA+ models of seat acquisition, multi-seat Booking, and deadlock freedom

Phase 6, formal track, tickets F1 (#43) and F2 (#45). Model-checked with TLC, run from a pinned
`tla2tools.jar` inside a pinned JRE Docker image — no local Java required.

```bash
npm run formal:check                     # invariants must HOLD on the default model
npm run formal:check:negative            # every checker must be shown to FAIL
bash formal/check.sh --all               # both
FORMAL_SHOW_TRACE=1 npm run formal:check:negative   # also print the counterexample traces
```

`check.sh` picks the module from the config name (`Deadlock*` → `DeadlockFreedom.tla`, `Lifecycle*` → `SeatLifecycle.tla`, `Crash*` → `CrashRecovery.tla`, otherwise `SeatBooking.tla`). The F3 and F4 layers are documented in their own sections at the end of this file.

Exit status is non-zero on any violation (positive mode) or on any control that
*fails to fail* (negative mode). A negative control only passes if TLC exits 12
**and** names the expected invariant (or, for `DeadlockUnsortedStuck`, exits 11 with `Deadlock reached`), so a parse error or a different violation
cannot pass for "violation found".

## Files

| File | Role |
|---|---|
| `SeatBooking.tla` | The spec. `ClaimMode` selects the claim primitive. |
| `MutualExclusion.cfg` | `atomic`, invariant `MutualExclusion` (+ `TypeOK`). Must pass. |
| `Atomicity.cfg` | `atomic`, invariant `Atomicity` (+ `TypeOK`). Must pass. |
| `NaiveMutualExclusion.cfg` | `naive`, `MutualExclusion`. **Negative control: must be violated.** |
| `PartialAtomicity.cfg` | `partial`, `Atomicity`. **Negative control: must be violated.** |
| `Witness.cfg` | `atomic`, `NoContendedOutcome`. **Vacuity guard: must be violated** — shows the default model reaches a committed two-seat Booking alongside a conflict-aborted request, so the passing invariants aren't passing on a model that never contends. |
| `DeadlockFreedom.tla` | F2's separate module: blocking lock acquisition with a wait-for relation. `AcqMode` selects `unsorted` / `sorted` / `nowait`. See [Deadlock freedom](#deadlock-freedom-f2-45). |
| `DeadlockSorted.cfg` | `sorted`, `NoWaitForCycle` (+ `TypeOK`, + TLC's own stuck-state check). Must pass. |
| `DeadlockNowait.cfg` | `nowait`, `NoWaitForCycle` (+ `TypeOK`, + stuck-state check). Must pass. |
| `DeadlockUnsorted.cfg` | `unsorted`, `NoWaitForCycle`. **Negative control: must be violated.** |
| `DeadlockUnsortedStuck.cfg` | `unsorted`, only `TypeOK`. **Negative control: TLC must report `Deadlock reached`** (exit 11) — the same bug seen through TLC's built-in stuck-state check instead of my cycle checker, so the cycle checker and a genuinely stuck state are shown to coincide. |
| `DeadlockSortedWitness.cfg` | `sorted`, `NoHoldAndWait`. **Vacuity guard: must be violated** — `sorted` really reaches a request waiting while holding a lock (the ingredient a deadlock needs). |
| `DeadlockNowaitWitness.cfg` | `nowait`, `NoConflictAbort`. **Vacuity guard: must be violated** — `nowait` really reaches a contended abort alongside a committed request. |
| `tla2tools.pin` | Pinned TLC version, download URL, SHA-256, and JRE image digest. |
| `check.sh` | The runner behind the npm scripts. Downloads the jar into `.cache/` (gitignored) on first use and refuses to run it if its SHA-256 differs from the pin. |

## Claim primitives (`ClaimMode`)

- **`atomic`** (default) — check-and-claim of one seat is one atomic step that also sees
  *in-flight* claims. Models `SELECT … FOR UPDATE NOWAIT` (`pessimistic`, ADR-0006) and the
  unique-index entry of an in-flight `INSERT … ON CONFLICT` (`unique_constraint`, ADR-0008). A
  request that finds a seat already claimed aborts and rolls back all its claims (HTTP 409).
- **`naive`** — unguarded read-then-write with **no unique backstop**: the availability read
  sees committed rows only; the write after it is unconditional. This is `naive.ts` as it
  behaved *before* ADR-0008. Expected to violate `MutualExclusion`.
- **`partial`** — per-seat `INSERT … ON CONFLICT DO NOTHING` whose affected-row count is
  ignored, so a request commits whichever seats it won. Not a mechanism in `src/`; it exists so
  the `Atomicity` checker is also shown capable of failing. Expected to violate `Atomicity`.

## Invariants

- **MutualExclusion** — a seat belongs to at most one *committed* Booking.
- **Atomicity** — a committed Booking holds exactly the seats it requested; a request that
  never started or aborted leaves no rows behind. (In a transactional model this is largely
  true by construction; the invariant exists to catch a spec — or a SQL path — that commits
  partial results, which `partial` demonstrates.)

## Abstractions

1. **One Event, one seat pool.** Seat rows, `seats.status`, and `booking_seats` rows are collapsed
   into one thing: `rows[r]`, the seats request `r` has written a claim for.
2. **Visibility.** A claim is invisible to others' plain reads until its transaction commits
   (read committed), but under `atomic` it is already visible to *claim attempts* — that is what a
   held row lock or an in-flight unique-index entry is.
3. **No blocking.** `atomic` fails fast on contention (NOWAIT / ON CONFLICT), matching ADR-0006.
   Blocking acquisition and lock ordering are modeled in F2 (#45, `DeadlockFreedom.tla`), not here, so request-internal
   seat order is nondeterministic and irrelevant.
4. **Single attempt.** Each request runs once: no retries, no idempotency key, no cancellation,
   no crash or ambiguous commit. Holds/Confirm/Reaper/Cancel are F3 (#46); faults and idempotent
   retry are F4 (#47).
5. **Not modeled:** `optimistic`'s version column, `advisory` locks, `serializable`'s SSI. The
   model treats them as realizations of the same "atomic claim" contract; F5 (#48) maps spec
   actions to the SQL that implements them.
6. **No liveness.** Safety only (`Spec` has no fairness); reaper liveness is F3.

## Small-scope bounds

3 requests, 3 seats, seat sets of size 1 or 2. `want` is *not* fixed in the config: `Init`
ranges over every assignment of one of the 6 admissible seat sets to each request (216 initial
states), so contention patterns (shared seat, overlapping pairs, identical pairs, disjoint) are
all covered exhaustively rather than by a hand-picked scenario. Default model: 59,550 states
generated, 23,262 distinct; exhaustive within these bounds. Small-scope evidence is not a proof
for arbitrary N — it is the small-scope hypothesis: counterexamples to protocols like this one
almost always appear at two or three participants (the naive control's trace is 7 states).

## Deadlock freedom (F2, #45)

`DeadlockFreedom.tla` models what `SeatBooking.tla` abstracts away: a lock that is already held
makes the next requester *wait*. Each request acquires one lock per wanted seat, one step at a
time, holds all of them until it commits, and a blocked acquisition is simply not enabled. The
invariant `NoWaitForCycle` says no reachable state contains a wait-for cycle (request A waiting on
a lock B holds while B waits on one A holds, transitively). A "lock" stands for whatever a
mechanism blocks on: a `seats` row lock, or an in-flight unique-index entry — Exhibit D showed the
real `naive` cycle was on the latter (`INSERT … unnest($ids)` against `booking_seats_seat_id_key`),
and the model deliberately does not care which.

| `AcqMode` | Behavior | Result (3 requests, 3 seats, sets ≤ 2) |
|---|---|---|
| `unsorted` | Block, in the order the client sent `seat_ids` | **Cycle found** — 3-state counterexample: one request takes seat 1 then wants 2, another takes 2 then wants 1. TLC's own stuck-state check independently reports `Deadlock reached` on the same state. |
| `sorted` | Block, in ascending seat order | **No wait-for cycle, no stuck state** (6,876 distinct states). Still reaches hold-and-wait states, so it is not clean for lack of contention. |
| `nowait` | Never block: a held lock aborts the request and releases its locks | **Cycle-free, no stuck state** (54,531 distinct states), with the acquisition order still client-chosen. |

**Why `pessimistic` and `advisory` are deadlock-free by construction (ADR-0006).** Deadlock needs
hold-and-wait: a request holds a lock *and waits* for another. `FOR UPDATE NOWAIT` and
`pg_try_advisory_xact_lock` never wait — a held lock fails the attempt at once (HTTP 409) and the
transaction rolls back everything it took. The wait-for graph has no edges, so it has no cycles,
whatever order the seats arrive in. That is why `nowait` takes the unsorted orderings in the model:
freedom does not come from ordering. (ADR-0006 chose NOWAIT for FR1's "409 immediately"; deadlock
freedom is a side effect, and `pessimistic.ts`/`advisory.ts` sorting `seat_ids` anyway, issue #30,
is only uniformity.) Because `nowait` is trivially cycle-free, its check is only meaningful next to
its vacuity guard, which shows the model does reach a contended abort with another request
committing.

**How `sorted` corresponds to ADR-0014's fix.** `naive`, `unique_constraint`, `optimistic` and
`serializable` block (on the row lock or index entry), so they *can* deadlock on an unordered
multi-seat set — the `unsorted` row, observed for real in Exhibit D. Their primary defense is
sorting `seat_ids` before any write (`normalizeSeatIds`, issue #31): every request then acquires in
the same global order. If A waits on seat `s` held by B, then everything A already holds is below
`s` (A's next seat is its smallest not-yet-taken one), and if B in turn waits on `t`, then `t` is
above `s` (B holds `s`). So each hop along a wait-for chain waits on a strictly higher seat, and a
chain can never close into a cycle. That informal argument is what the `sorted` row checks
exhaustively, for the abstract protocol only.

What this does **not** show:

- The sort being *implemented* correctly in `src/` (e.g. the case-insensitive string sort of
  `normalizeSeatIds` is a total order on the ids as stored) — that is F5's spec-action → SQL
  mapping, plus Exhibit D's measured before/after.
- The fallback layer: `withDeadlockRetry` / `serializable`'s extended retry loop (ADR-0014) and
  `retry_exhausted` (ADR-0015) recover from a deadlock the detector aborts. The model has no
  detector, no retries and no aborts in the blocking modes; `sorted` proves the fallback is never
  *needed* in the abstract protocol, not that it works.
- Locks Postgres takes that the model has no seat for (e.g. the `seats` row `UPDATE` after the
  `booking_seats` insert): any seat-level lock is one more acquisition in the same global order.
- Anything about the sort key differing between two requests (mixed old/new code): out of scope.

**Bounds.** Same as F1 (3 requests, 3 seats, seat sets of size 1 or 2) — a deadlock needs only two
requests and two two-seat sets, so no widening was needed. `order[r]` is not fixed in the config:
`Init` ranges over every ordering of every admissible seat set for each request (729 initial states
for `unsorted`/`nowait`, 216 for `sorted`). `Seats` is `{1, 2, 3}` rather than F1's model values
because the sorted protocol needs a `<` on seats.

## Pinning

TLC 2.19 (`tla2tools.jar` v1.7.4), SHA-256 `936a2620…8e88`; full value, URL and the JRE image
digest in `tla2tools.pin`. The checksum was computed from the release asset at pin time (GitHub
published no asset digest for v1.7.4), so it guards against later drift or tampering, not against
a compromised original download.

---

# Lifecycle layer — `SeatLifecycle.tla` (F3, #46)

Phase 5's Hold → Confirm → Booking flow plus Expire, the Reaper and Cancel, for `pessimistic` only
(ADR-0017). A separate module with its own `Lifecycle*.cfg` files: `SeatBooking.tla` is untouched.
Run through the same `npm run formal:check` / `formal:check:negative`.

| Spec action | Implementation |
|---|---|
| `AcquireHold` | `holdSeatsPessimistic` — `FOR UPDATE NOWAIT`, all seats `available` or 409 |
| `DirectBook` | `bookSeatPessimistic` — same acquisition, straight to `booked` |
| `Expire(r)` | time passing: sets `expired[r]`, never cleared, only while the Hold exists |
| `ConfirmLock` / `ConfirmCommit` | `confirmHoldPessimistic`: the `JOIN … FOR UPDATE OF s NOWAIT` + `held_until` check, then `insertBookingForSeats` + teardown |
| `Reap(r)` | `runReaperSweep`: `WHERE status = 'held' AND held_until < now()` |
| `Cancel` | `DELETE /bookings/:id` |

Seats are `available`/`held`/`booked`; `seat[s]` is `seats.status`, `holdRows`/`bookRows` are the
`hold_seats`/`booking_seats` rows.

## Why Confirm is two steps

The confirm-vs-reaper race is not "both check expiry at once" (the monotonic flag orders those). It
is: confirm checks the Hold unexpired and takes its row locks (`confirming`); *then* the TTL elapses;
the Reaper's UPDATE reaches the same rows. The correct Reaper is blocked by confirm's lock and, once
confirm commits, finds the row `booked` and skips it (EPQ re-check) — in the model, `Reap` is simply
not enabled in `confirming`, nor after `confirmed`. `ReaperMode = "stale"` is issue #40's trap (an id
list computed before confirm committed, applied with no re-check) and must be caught.

## Safety invariants (`LifecycleSafety.cfg`, must hold)

| Invariant | Meaning |
|---|---|
| `SeatBelongsToAtMostOne` | no two requests own a seat, and no request owns it as both Hold and Booking |
| `SeatStatusAgrees` | `seats.status` matches the existence of `hold_seats` / `booking_seats` rows |
| `HoldConfirmedAtMostOnce` | at most one Confirm commits per Hold |
| `NoConfirmOnExpired` | every confirm in flight or committed saw its Hold unexpired when it checked |
| `ReapOnlyExpired` | the Reaper only releases expired Holds |

`NoConfirmOnExpired`, `ReapOnlyExpired` and `HoldConfirmedAtMostOnce` are close to guard-structural
(the action's own guard enforces them); their value is that the controls below prove deleting the guard
is *detected*. `SeatStatusAgrees` / `SeatBelongsToAtMostOne` are the ones that check the
*interaction* (confirm × reaper × cancel × new holds).

## Negative controls — each must fail, for the named reason

| Config | Mutation | Must violate | Trace |
|---|---|---|---|
| `LifecycleNoExpiryCheck` | Confirm skips the expiry check (`ConfirmMode = noExpiryCheck`) | `NoConfirmOnExpired` | 4 |
| `LifecycleReplayConfirm` | Confirm skips "hold still exists" (`replayable`) | `HoldConfirmedAtMostOnce` | 6 |
| `LifecycleUnguardedReaper` | Reaper drops its `held_until` predicate (`noExpiryGuard`) | `ReapOnlyExpired` | 3 |
| `LifecycleStaleReaper` | Reaper applies a precomputed list, no re-check (`stale`) | `SeatStatusAgrees` | 7 |
| `LifecycleStaleReaperExclusion` | same mutation, checked at its consequence | `SeatBelongsToAtMostOne` | 8 |

The `stale` trace is the real race: hold → `ConfirmLock` → `Expire` → reaper snapshots the hold as expired
→ `ConfirmCommit` (seats `booked`, Booking exists) → reaper applies, seats `available` while the Booking
still owns them. The last extends one step further (another request takes the seat) to a double claim.

## Vacuity guards (`LifecycleWitness*.cfg`, must be violated)

Show the passing invariants are not passing on a model that never gets there:
`NoExpiryDuringConfirm` (TTL elapses while confirm holds its locks), `NoConfirmWonAfterExpiry` (confirm
legitimately commits on a Hold that is expired by then), `NoReuseAfterReap` (a reaped Hold's seat is
claimed again), `NoBookingBlockedByHold` (a direct booking loses to a live Hold), `NoCancelAfterConfirm`.

## Liveness (separable: `LifecycleLive*.cfg`; drop these to cut it)

- **`ExpiredHoldResolved`** — under weak fairness on **the Reaper alone**, a Hold that is `held` and
  expired does not stay `held` (`LifecycleLiveReaper.cfg`, holds).
- **`NoSeatHeldForever`** — the issue's statement, "no seat stays `held` forever". A seat held by a Hold
  that never expires is held legitimately, so this additionally needs two environment assumptions: time
  passes (`WF Expire`) and an in-flight confirm transaction finishes (`WF ConfirmCommit`).
  `LifecycleLiveSeat.cfg`, holds.
- Controls (TLC exit 13, `Temporal properties were violated`), each differing from a passing twin in
  exactly one assumption: `LiveNoFairness` (no fairness at all → stuck with an expired `held` Hold),
  `LiveReaperDisabled` (`ReaperMode = disabled` → same), `LiveNoTimeFairness` (a live Hold never expires),
  `LiveNoCommitFairness` (a confirm stays `confirming` forever). The traces end in the corresponding stuck
  state, checked by hand; `check.sh` asserts exit 13 + the TLC message (TLC does not print which property).

The liveness fit the budget at the full bounds; nothing was reduced.

## Abstractions (F3-specific; F1's still apply)

1. **Atomic claim.** `AcquireHold`/`DirectBook` are one all-or-nothing step each; per-seat claim
   interleaving is F1's (`ClaimMode = atomic`), already shown mutually exclusive and atomic.
2. **One clock-free TTL.** The app checks `held_until` against `Date.now()` (confirm), the Reaper against
   the DB's `now()`. The model has one `expired` flag, so cross-clock skew is not represented. Skew
   cannot break the row-lock/EPQ ordering above, but it can make confirm accept a Hold the DB already
   considers expired (app clock behind) or answer 410 early (ahead).
3. **Sweep granularity.** The real sweep is one atomic statement over every expired Hold; the model reaps
   one Hold per step, a superset of the orderings.
4. **Failed confirms are stutters.** A confirm that gets 409 (lock taken), 410 (expired) or 404 (gone)
   changes no state and is not an enabled step; their effect is what is *not* enabled.
5. **No retries/idempotency/faults** — F4 (#47). One Hold per request; Cancel only on Bookings.

## Bounds and state counts

3 requests, 3 seats, seat sets of size 1–2, 216 initial states (as F1). Every config explores the same
graph: **665,730 states generated, 327,606 distinct, depth 16**, exhaustive within the bounds. The
liveness runs check the same graph (≈10 s each in Docker). Small-scope evidence, not a proof for
arbitrary N.

---

# Crash, ambiguous-commit and idempotent-retry layer — `CrashRecovery.tla` (F4, #47)

The invariants of F1–F3 proven over *failure*, not just interleaving: the backend serving a request
can die at any step, and a client that never heard back retries with the same Idempotency Key. A
separate module with its own `Crash*.cfg` files; `SeatBooking.tla` and `SeatLifecycle.tla` are
untouched (their actions are monolithic, so the Hold → Confirm → Booking / Expire / Reaper / Cancel
picture of F3 is re-stated here, with crash steps and keys added, rather than instantiated).
`pessimistic` only (ADR-0017). It is the formal counterpart of chaos Oracle 3 (ADR-0022): "a retried key
never produces a second Booking or Hold".

## What the model is

A request is one **attempt**; two attempts carrying the same key are the same logical request, so a
client retry, a double-click and a duplicate from another user are all "another attempt with this key"
(CONTEXT.md: *Idempotency Key*). `prof[r]` fixes at Init what attempt `r` is — `book`, `hold` or `confirm`
(a confirm's key is its Hold's, as `hold-confirm:<id>`) — and which seats and key it carries, ranging
over every combination (15,588 initial states). A client can confirm only a Hold whose id it has learned
(an ack or a replay). One attempt, step by step:

| Spec action | Implementation |
|---|---|
| `Begin` | the fast-path `findExisting{Booking,Hold}ByIdempotencyKey` (`idempotency.ts`): a committed row with this key → replay, no transaction |
| `Lock` | `SELECT … FOR UPDATE NOWAIT` (`pessimistic.ts`, `pessimisticHold.ts`): a seat locked by another open transaction, or not `available` → 409 |
| `InsertKey` | `INSERT INTO bookings\|holds (idempotency_key)`: an uncommitted same-key row **blocks** the insert (unique-index wait); a committed one → unique violation → `resolveIdempotencyKeyRace` → replay |
| `Commit` | `COMMIT` — the rows and the `seats` UPDATE become visible together; durable from here |
| `Ack` | the 201 reaches the client |
| `CLockConflict` / `CLockGone` / `CLockExpired` / `CLockOk`, `CCommit` | `confirmHoldPessimistic`: 409 / the in-transaction fallback lookup (replay or 404) / 410 / row locks taken, then `insertBookingForSeats` + hold teardown |
| `CrashBeforeCommit` | the backend dies at `begun`, `locked`, `keyed` or `clocked`: rolled back, locks and pending key row released, nothing visible |
| `CrashAfterCommit` | commit-then-crash: the write is durable, only the ack is lost — **the Ambiguous outcome** |
| `Expire` / `Reap` / `Cancel` | as F3 (guarded Reaper only); `Cancel` deletes the row, and with it the key (ADR-0020) |

The client cannot tell a crash before `COMMIT` from one after it, so both end in `pc = "crashed"`; the ghost
`durable[r]` (never cleared by a crash) records which it was, for the invariants only. Any attempt may begin
at any time, so a retry may follow a crashed attempt, overlap an in-flight one, or arrive after it finished.

## Invariants (`CrashSafety.cfg`, must hold with Crash enabled)

| Invariant | Meaning |
|---|---|
| `SeatBelongsToAtMostOne`, `SeatStatusAgrees`, `Atomicity`, `HoldConfirmedAtMostOnce`, `NoConfirmOnExpired`, `ReapOnlyExpired` | F1/F3's, unchanged in meaning (`Atomicity`: a Booking holds exactly the seats it was for, a Hold exactly its own) |
| `KeyAtMostOneBooking`, `KeyAtMostOneHold` | at most one live Booking, and one live Hold, per key (Oracle 3) |
| `NoOrphanState` | **fault assumption 1** — a dead backend leaves no row lock and no in-flight key row |
| `CommittedPersists` | **fault assumption 2** — whatever committed (acknowledged *or* ambiguous) is still there unless Cancel / Confirm / the Reaper legitimately removed it |
| `CleanConflict`, `AmbiguousRetryNotRefused`, `ConfirmNeverFalselyRefused` | a retry that overlapped no other same-key attempt is never answered 409/404 while a committed row carries its key — after an ambiguous commit it **replays**; a confirm is never falsely refused even when it overlaps |
| `KeyReuseOnlyAfterRelease` | the precise statement of key lifetime: a second durable Booking/Hold for one key exists only after the first was cancelled / reaped / confirmed |

The two fault assumptions are explicit and falsifiable (controls below); they are what the model *assumes*
about Postgres, which is exactly what chaos tickets C1/C3/C4 test empirically.

## Negative controls — each must fail, for the named reason

| Config | Mutation | Must violate | Trace |
|---|---|---|---|
| `CrashNoLookup` | the retry path skips the key lookup (`LookupMode = skip`; the UNIQUE constraint stays) | `AmbiguousRetryNotRefused` | 8 |
| `CrashNoKeyDedupe` | no lookup **and** no UNIQUE on the key (`KeyMode = none`) — two Bookings for one key | `KeyAtMostOneBooking` | 9 |
| `CrashNoKeyDedupeHold` | same, for Holds | `KeyAtMostOneHold` | 9 |
| `CrashLoseCommitted` | a crash right after `COMMIT` un-commits the write (`CrashMode = loseCommitted`) | `CommittedPersists` | 6 |
| `CrashKeepLocks` | a crashed backend's row locks are never released (`keepLocks`) | `NoOrphanState` | 4 |
| `CrashKeepUncommitted` | the `seats` UPDATE of a crashed, uncommitted transaction survives (`keepUncommitted`) | `SeatStatusAgrees` | 5 |
| `CrashNoExpiryCheck` | Confirm skips the expiry check (F3's control, re-run under Crash) | `NoConfirmOnExpired` | 9 |
| `CrashLiveNoFairness` | no fairness: a retry may simply never start | `RetryAfterCrashAnswers` (exit 13) | 9 |
| `CrashLiveKeepPending` | a crashed backend's in-flight key row is never released: the retry waits forever | TLC `Deadlock reached` (exit 11) | 7 |

`CrashNoLookup`'s trace is the Ambiguous outcome resolved wrongly: attempt 1 books `{s1}`, commits and crashes
before its ack; the client retries with the same key, the lookup is skipped, `Lock` finds `s1` booked and
the retry is told **409 while its own Booking exists**. `CrashLoseCommitted` and `CrashKeepUncommitted` are
the durability and atomicity assumptions made visible: a model that quietly got them wrong would pass
`CrashSafety` vacuously, and these show it would not.

**Why `CrashNoKeyDedupe` needs two attempts with different seats.** With the lookup skipped but the UNIQUE
constraint and seat exclusivity intact, two Bookings for one key are impossible for the *same* seats
(`CrashNoLookup` — the loser is refused instead, not duplicated). A second Booking per key needs both key
guards gone *and* a retry that wants different seats — which is what CONTEXT.md's key definition allows ("the
same attempt regardless of who submitted it"). So in this implementation the key is the second line of defence
against duplicates and the **first** line of defence for the *answer* a retry gets.

## Vacuity guards (`CrashWitness*.cfg`, must be violated)

`NoAmbiguousCommit` (durable and unacknowledged is reachable) · `NoReplayAfterAmbiguousBooking` / `…Hold` /
`…Confirm` (a retry replays after an ambiguous commit, for each endpoint) · `NoKeyRaceReplay` (the
lookup-then-insert race ends in a unique violation resolved to a replay) · `NoWaitOnKeyRow` (an insert really
waits on another transaction's in-flight same-key row) · `NoUnblockedByCrash` (a PROPERTY: a waiter is
released by the holder's crash *before commit* and then proceeds) · `NoSeatReuseAfterMidCrash` (a crash with
locks held frees its seats for someone else) · `NoConfirmCrashMidTxn`, `NoReapAfterConfirmCrash`,
`NoRetryConfirmAfterMidCrash` (a Confirm crashed holding the Hold's locks; the Reaper and a retried Confirm
both then make progress).

## Liveness / recovery (`CrashLive*.cfg`; separable — drop these to cut it)

`CrashLiveRecovery`, under weak fairness on every attempt's own steps, checks two properties with at most
**one** Fault ("no further faults": the budget is spent once any attempt has crashed):

- **`NoAttemptHangs`** — an in-flight attempt eventually finishes: commits, answers or crashes. Includes one
  waiting on another attempt's in-flight key row.
- **`RetryAfterCrashAnswers`** — once an attempt of a key has crashed, any not-yet-started attempt with that
  key gets a definite answer (created, replay or conflict) and does not hang. Together with `CleanConflict`
  (the answer is a replay, never a false conflict, when nothing overlaps) and `KeyAtMostOne*`, this is the
  recovery property: *after a crash with no further faults, a retry resolves to exactly one Booking or a clean
  conflict*.

Checked at a reduced scope (see Bounds). Controls: `CrashLiveNoFairness` and `CrashLiveKeepPending` above.

## Findings: behavior the model exposes in the real implementation

Both are `CrashFinding*.cfg` — invariants *violated on purpose*, because the behavior they name is real. Neither
breaks a chaos Oracle (ADR-0022 reads stored state after the Fault clears), so neither is a Correctness
violation; they are Robustness-class observations about what a retry can be told.

1. **Idempotency record lifetime is row lifetime** (`CrashFindingKeyReuse` trace 10, `CrashFindingHoldKeyReuse`
   trace 11). The key's only home is the `bookings` / `holds` row (`idempotency_key … UNIQUE`), and ADR-0020
   deletes that row on Cancel, Confirm and reap. So "a key creates at most one Booking/Hold *ever*"
   (`BookingKeyCreatesAtMostOne`, `HoldKeyCreatesAtMostOne`) is false: book, cancel, retry the same key, and a
   second Booking is created; hold, let it expire and be reaped, retry the same key, and a second, fresh Hold is
   created. What holds is `KeyAtMostOneBooking` / `KeyAtMostOneHold` (at most one **live** row) and
   `KeyReuseOnlyAfterRelease`. Oracle 3's wording ("no key has more than one Booking") is satisfied by exactly
   this reading; a client that replays a stale request after cancelling gets a new Booking, not a replay.
2. **A concurrent same-key book/hold attempt can be told 409 although its key's row is committed**
   (`CrashFindingSpuriousConflict`, trace 7). `bookSeatPessimistic` / `holdSeatsPessimistic` do their key lookup
   *before* `BEGIN`; if the original commits between that lookup and the retry's `FOR UPDATE NOWAIT`, the retry's
   lock succeeds, sees the seat taken, and answers 409 (`conflict`) — not a replay. (If the original is still in
   flight, `NOWAIT` fails immediately: also 409, but then no row is committed yet.) If the original's ack is lost
   too, the client's only answer is a 409 for a request that succeeded; it takes *another* retry — which then
   overlaps nothing and replays (`CleanConflict`) — to learn the truth. `resolveIdempotencyKeyRace` (unique
   violation → replay) does not catch it: under `pessimistic` that path is reachable only when a same-key retry
   wants *different* seats (`CrashWitnessKeyRace`), because for the same seats `NOWAIT` / the status check refuses
   first. **The confirm path is not affected** (`ConfirmNeverFalselyRefused` holds): `confirmHoldPessimistic`
   repeats the key lookup *inside* the transaction, after its locks, when the Hold's rows are gone — that is the
   `CLockGone` branch, and it is what the book/hold paths lack.

Positive results worth stating plainly: a retry after an ambiguous commit replays for all three endpoints
(`CrashWitnessReplay*`); crash before commit leaves no row, lock or pending key behind (`NoOrphanState`);
a Confirm that crashes holding the Hold's locks neither double-confirms nor strands the Hold (`HoldConfirmedAtMostOnce`,
`CrashWitnessReapAfterConfirmCrash`).

## What is NOT modeled

- **Postgres restart, WAL replay, fsync, replication.** `CommittedPersists` *assumes* a returned `COMMIT` is
  durable; whether a crashing server honors that is chaos ticket C4 (#51). `CrashLoseCommitted` shows what
  happens to the spec if it does not.
- **Network partitions, packet loss, client timeouts as their own events.** A response lost without a crash is
  indistinguishable, to the database, from an attempt whose client stopped listening, and a retry may begin at
  any time, so the *state-level* effects are covered; partition-and-heal latency behavior is C2 (#49).
- **App-process SIGKILL** is modeled as `Crash` of its in-flight transactions (a dropped connection aborts the
  open transaction); the process-level robustness findings (R1–R4) are not state-level and are not represented.
- **The Reaper as a process.** It is one atomic step per Hold. C3's R5 (a stalled reaper keeping row locks on
  the other expired seats of its single `UPDATE`) is therefore not reproduced here.
- **Timeouts** (`statement_timeout`, `lock_timeout`, idle-in-transaction) — none exist in the implementation (R4).
- The other five mechanisms, `retry_exhausted`, deadlock retry; optimistic/advisory/serializable internals. A
  client that retries with a key it was never given (no ack, no replay) cannot confirm — Hold ids are
  unguessable. `known` models only that.
- **Cross-clock TTL skew** (as F3).

## Bounds and state counts

3 attempts, 3 seats, seat sets of size 1–2, 2 keys, up to 3 Faults (every attempt may crash once; no budget
was cut). `prof` ranges over all profiles — 15,588 initial states, 298 distinct under symmetry. **Nothing was
reduced for the safety run.**

| Run | Distinct states | Notes |
|---|---|---|
| `CrashSafety` | 521,770 (1,602,484 generated) | symmetry over attempts, seats and keys (`SYMMETRY Sym`; sound for safety only) |
| same, **no symmetry** | 33,000,288 (100,376,208 generated), 6 min 29 s | exhaustive cross-check of the reduction; not part of `check.sh` |
| `CrashLiveRecovery` | 354,291 (833,760 generated), ≈50 s | **reduced**: 2 seats, 1 key, 1 Fault, `Cancel` off, no symmetry (TLC's symmetry reduction is unsound for liveness). 3 attempts kept — the recovery shape needs a crashed attempt, a retry and a possible third party. |

The liveness scope was reduced because the full graph carries a liveness check's per-state cost; the
reduction removes dimensions orthogonal to recovery (extra seat and key identities, `Cancel`, a second Fault)
and leaves Hold / Confirm / Expire / Reap in. Everything else — controls, witnesses, `CrashSafety` — runs at
the full bounds. Small-scope evidence, not a proof for arbitrary N.
