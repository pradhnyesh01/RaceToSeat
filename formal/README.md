# formal/ — TLA+ model of seat acquisition and multi-seat Booking

Phase 6, formal track, ticket F1 (#43). Model-checked with TLC, run from a pinned
`tla2tools.jar` inside a pinned JRE Docker image — no local Java required.

```bash
npm run formal:check                     # invariants must HOLD on the default model
npm run formal:check:negative            # every checker must be shown to FAIL
bash formal/check.sh --all               # both
FORMAL_SHOW_TRACE=1 npm run formal:check:negative   # also print the counterexample traces
```

Exit status is non-zero on any violation (positive mode) or on any control that
*fails to fail* (negative mode). A negative control only passes if TLC exits 12
**and** names the expected invariant, so a parse error or a different violation
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
   Blocking acquisition and lock ordering are modeled in F2 (#45), not here, so request-internal
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
