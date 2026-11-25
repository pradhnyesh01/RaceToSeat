# Exhibit G — Phase 6 formal verification: TLA+ models of the `pessimistic` claim, deadlock, lifecycle and crash-recovery protocols

Phase 6 deliverable (todo.md, issue #48 / F5, under umbrella #42): the formal half of "survives failure, not just the happy path". Four small TLA+ modules in `formal/` are model-checked exhaustively with TLC, every checker is shown to fail on a deliberately broken variant, and a hand-audited table maps each spec action to the SQL that implements it. The chaos half of Phase 6 is [Exhibit H](exhibit-h-phase6-chaos.md); this exhibit says which claims each half supports and which neither does. Decisions about *why* the verification is shaped this way are in ADR-0021; the chaos side's equivalent are ADR-0022 and ADR-0023.

**What this exhibit does not claim.** It is a small-scope model-checking result (3 requests, 3 seats) about *abstract protocols*, joined to the real code by a table a person wrote and a test that only checks the table still points at real lines. It is not a proof of the implementation, and it is not a proof for arbitrary N. The "What this does not prove" section is part of the result, not a footnote.

Every figure below was recomputed on 2026-11-25 by running `bash formal/check.sh --all` once (exit 0, 3 min 17 s wall including the first-use jar download) and then timing each positive configuration separately with the same `docker run` invocation `check.sh` uses (`check.sh` prints state counts but not run times). Nothing was copied from `formal/README.md`; where a number there differs, this exhibit's is the recomputed one (see "Record consistency check").

## Headline

|  |  |
|---|---|
| Positive checks (every invariant / property must hold) | **9 of 9 pass** — 4 modules; 6 safety runs, 3 liveness runs |
| Negative controls, findings, vacuity guards (each must fail, for the named reason) | **44 of 44 fail as required** — traces of 3 to 12 states |
| Strongest result | The seat-ownership invariants (`MutualExclusion` in F1, `SeatBelongsToAtMostOne` in F3/F4: no seat is in two Bookings, or both Held and Booked, or held twice), `HoldConfirmedAtMostOnce` and `KeyAtMostOneBooking` hold in every reachable state of the bounded models — in the F4 runs **with a backend crash injected at any step and clients retrying with the same key** (`CrashSafety`: 1,602,484 states generated, 521,770 distinct) |
| Deadlock A/B | blocking acquisition in client order **deadlocks in 3 steps**; the same protocol with seats sorted, or with non-waiting acquisition (`NOWAIT` / try-lock), **cannot** |
| Production code changed by this ticket | None: `src/`, `db/schema.sql`, `load-harness/` and every `.tla` / `.cfg` are untouched |
| New findings about the real implementation | RF1, RF2 (found by F4, recorded in Exhibit H and the ticket drafts) + three **mapping-audit observations** (O1–O3) reported here for the first time; none is a safety violation |

## What the models are for

The project's one hard gate is *zero double-booking under concurrency* (CLAUDE.md). Load tests (Exhibits A–F) and chaos tests (Exhibit H) sample interleavings; a model checker enumerates all of them, within bounds. The four modules ask four separate questions, each over the `pessimistic` flow where holds are involved (ADR-0017) and over an abstract "atomic claim" where only seat claiming is:

| Module | Ticket | Question | Where the answer lives |
|---|---|---|---|
| `SeatBooking.tla` | F1 #43 | Under any interleaving of ≤3 requests for ≤3 seats (sets of 1–2), does a seat ever belong to two committed Bookings, and is a multi-seat Booking ever partial? | `MutualExclusion`, `Atomicity` |
| `DeadlockFreedom.tla` | F2 #45 | If acquisition *blocks*, can requests form a wait-for cycle — and does ordering the seats, or never waiting, remove it? | `NoWaitForCycle` over `unsorted` / `sorted` / `nowait` |
| `SeatLifecycle.tla` | F3 #46 | Hold → Confirm → Booking, TTL expiry, the Reaper and Cancel: does any interleaving double-own a seat, confirm an expired Hold, confirm twice, or strand a seat `held` forever? | five safety invariants; `ExpiredHoldResolved`, `NoSeatHeldForever` |
| `CrashRecovery.tla` | F4 #47 | With the backend dying at any step and clients retrying with the same Idempotency Key, does a retry ever produce a second Booking/Hold, lose a committed write, or hang? | `KeyAtMostOne*`, `CommittedPersists`, `NoOrphanState`, `CleanConflict`, `NoAttemptHangs`, `RetryAfterCrashAnswers` |

`SeatBooking.tla` is the only module that looks at the claim *primitive* (`ClaimMode`); the others take its all-or-nothing claim as one atomic step, on the strength of `MutualExclusion` / `Atomicity` — that is the layering assumption ("F1 proves per-seat claiming under NOWAIT atomic, so F3 and F4 may treat it as one step") and it appears again under "What this does not prove".

## Toolchain and environment

| | |
|---|---|
| Model checker | TLC 2.19 of 08 August 2024 (rev 5a47802), from `tla2tools.jar` release **v1.7.4** |
| Jar checksum (SHA-256) | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` — verified against `formal/tla2tools.pin` by `check.sh` before every run, which refuses to run a jar that differs. The checksum was computed from the release asset at pin time (GitHub published no digest for v1.7.4): it guards against drift and tampering after that, not against a compromised original download |
| Docker image | `eclipse-temurin@sha256:541b08fc7f494edf14e436ff6bfb55767e4a115c87bfc547b8c5de957b58737f` (`eclipse-temurin:17-jre`, pinned by manifest-list digest) — OpenJDK 17.0.21 (Temurin 17.0.21+9), `linux/arm64` |
| JVM / TLC flags | `java -XX:+UseParallelGC -cp /tla/tla2tools.jar tlc2.TLC -nowarning -workers auto -metadir /tmp/tlc-states -config <name>.cfg <Module>.tla`; TLC reported 10 workers, 1765 MB heap |
| Machine | Apple M4, 10 cores, macOS 27.2.1; Docker engine 29.4.0 (10 CPUs, 8.3 GB given to the VM). Run times are for this machine and are not a benchmark |
| Specs checked at | commit `d3f972b` (no `.tla`, `.cfg`, `check.sh` or `tla2tools.pin` file differs between it and the commit that adds this exhibit) |

## Bounds

- **Requests / attempts: 3. Seats: 3. Seat sets: size 1 or 2** (6 admissible sets). The seat set each request wants is *not* fixed in the config: `Init` ranges over every assignment, so shared-seat, overlapping-pair, identical-pair and disjoint contention patterns are all covered exhaustively (216 initial states for F1/F3, 216 or 729 for F2). A deadlock needs only two requests and two two-seat sets, so no widening was needed there.
- **`CrashRecovery` safety (`CrashSafety`)**: 3 attempts, 3 seats, **2 keys**, up to **3** Faults (every attempt may crash once), `Cancel` on. `prof[r]` ranges over every profile (book / hold / confirm × seat sets × keys): 15,588 initial states, 298 distinct under symmetry. Run with `SYMMETRY Sym` (requests, seats and keys interchangeable), which is sound for safety and **not** for liveness. The un-reduced exhaustive cross-check (33,000,288 distinct states, 6 min 29 s) is documented in `formal/README.md` and is **not** part of `check.sh` and was not re-run for this exhibit.
- **`CrashLiveRecovery` — the one reduced scope, stated exactly**: 3 attempts, **2 seats (not 3), 1 key (not 2), at most 1 Fault (`MaxCrashes = 1`, "no further faults"), `Cancel` off**, no symmetry; fairness is weak fairness on every attempt's own steps (`SpecFair`). Hold / Confirm / Expire / Reap stay in. The reduction removes dimensions the recovery argument does not depend on (extra seat and key identities, Cancel, a second Fault), but it means **the two liveness properties of the crash layer are checked on a strictly smaller model than its safety invariants**. The F3 liveness checks (`LifecycleLiveReaper`, `LifecycleLiveSeat`) ran at the full bounds.
- The state graphs are exhaustive within those bounds: every run ended `Model checking completed. No error has been found.` with 0 states left on the queue.

Small-scope evidence is not a proof for arbitrary N. It is the small-scope hypothesis: counterexamples to protocols of this kind almost always appear with two or three participants, which the controls below corroborate (the shortest is 3 states, the longest 12).

## Positive checks — recomputed

Every positive configuration also checks `TypeOK`, and every non-liveness run uses TLC's built-in stuck-state (deadlock) check, so a non-terminal state with no enabled step would fail it. "TLC / wall": TLC's own `Finished in` (whole seconds) / wall clock of the `docker run` including container and JVM start.

| Config | Module | Kind | Checked | States generated | Distinct | Depth | TLC / wall |
|---|---|---|---|---|---|---|---|
| `MutualExclusion` | `SeatBooking` | safety (`Spec`) | `MutualExclusion` | 59,550 | 23,262 | 10 | 01s / 2.0 s |
| `Atomicity` | `SeatBooking` | safety (`Spec`) | `Atomicity` | 59,550 | 23,262 | 10 | 00s / 1.5 s |
| `DeadlockSorted` | `DeadlockFreedom` | safety (`Spec`) | `NoWaitForCycle` | 11,046 | 6,876 | 10 | 00s / 1.3 s |
| `DeadlockNowait` | `DeadlockFreedom` | safety (`Spec`) | `NoWaitForCycle` | 89,577 | 54,531 | 10 | 01s / 2.2 s |
| `LifecycleSafety` | `SeatLifecycle` | safety (`Spec`) | `SeatBelongsToAtMostOne`, `SeatStatusAgrees`, `HoldConfirmedAtMostOnce`, `NoConfirmOnExpired`, `ReapOnlyExpired` | 665,730 | 327,606 | 16 | 03s / 4.0 s |
| `LifecycleLiveReaper` | `SeatLifecycle` | liveness (`SpecReaperFair`) | `ExpiredHoldResolved` | 665,730 | 327,606 | 16 | 08s / 9.2 s |
| `LifecycleLiveSeat` | `SeatLifecycle` | liveness (`SpecFair`) | `NoSeatHeldForever` | 665,730 | 327,606 | 16 | 12s / 13.0 s |
| `CrashSafety` | `CrashRecovery` | safety (`Spec`) | `SeatBelongsToAtMostOne`, `SeatStatusAgrees`, `Atomicity`, `HoldConfirmedAtMostOnce`, `NoConfirmOnExpired`, `ReapOnlyExpired`, `KeyAtMostOneBooking`, `KeyAtMostOneHold`, `NoOrphanState`, `CommittedPersists`, `CleanConflict`, `KeyReuseOnlyAfterRelease`, `AmbiguousRetryNotRefused`, `ConfirmNeverFalselyRefused` | 1,602,484 | 521,770 | 22 | 10s / 11.0 s |
| `CrashLiveRecovery` | `CrashRecovery` | liveness (`SpecFair`) | `NoAttemptHangs`, `RetryAfterCrashAnswers` | 833,760 | 354,291 | 22 | 54s / 54.8 s |

Totals: 9 configurations, 4,653,157 states generated across the nine runs (the three F3 runs re-explore one 665,730-state graph).

Notes. `NoConfirmOnExpired`, `ReapOnlyExpired` and `HoldConfirmedAtMostOnce` are close to *guard-structural* — the action's own guard enforces them — and are worth having because the controls below prove that deleting the guard is *detected*. The ones that check an *interaction* (confirm × reaper × cancel × new holds × crash) are `SeatStatusAgrees` and `SeatBelongsToAtMostOne`. `DeadlockNowait`'s `NoWaitForCycle` is trivially true by construction (no waiting, so no edges); its substance is the stuck-state check plus its vacuity guard (below). `LifecycleLiveReaper` / `LifecycleLiveSeat` explore the same 665,730-state graph as `LifecycleSafety`, with a temporal check on top, which is why their wall time is longer.

## Negative controls, findings and witnesses

Following ADR-0023's rule that a checker never seen to fail proves nothing, and extending it to the formal track: every positive check has a variant that *must* go red, and `check.sh` only counts it if TLC exits with the expected code **and** names exactly the expected invariant (exit 12 + `Invariant X is violated`; exit 11 + `Deadlock reached`; exit 13 + `Temporal properties were violated`). A parse error or a different violation cannot pass for "violation found". The control mutates the *model* (a `.cfg` constant), never `src/` — the formal analogue of ADR-0023's "no production toggles". Trace length is the number of states in TLC's counterexample, from this run.

**Safety controls (a mutation the checker must catch)**

| Config | Module | Mutation / what it shows | Must violate | Trace (states) |
|---|---|---|---|---|
| `NaiveMutualExclusion` | `SeatBooking` | unguarded read-then-write, no unique backstop (`ClaimMode = naive`) | `MutualExclusion` | 7 |
| `PartialAtomicity` | `SeatBooking` | `INSERT ... ON CONFLICT DO NOTHING` with the affected-row count ignored (`partial`) | `Atomicity` | 6 |
| `DeadlockUnsorted` | `DeadlockFreedom` | blocking acquisition in client order (`AcqMode = unsorted`): the pre-ADR-0014 behavior | `NoWaitForCycle` | 3 |
| `DeadlockUnsortedStuck` | `DeadlockFreedom` | same, seen through TLC's own stuck-state check instead of the cycle checker | `TLC: Deadlock reached` | 3 |
| `LifecycleNoExpiryCheck` | `SeatLifecycle` | Confirm skips the expiry check (`ConfirmMode = noExpiryCheck`) | `NoConfirmOnExpired` | 4 |
| `LifecycleReplayConfirm` | `SeatLifecycle` | Confirm skips "hold_seats rows still exist" (`replayable`) | `HoldConfirmedAtMostOnce` | 6 |
| `LifecycleUnguardedReaper` | `SeatLifecycle` | Reaper drops its `held_until` predicate (`noExpiryGuard`) | `ReapOnlyExpired` | 3 |
| `LifecycleStaleReaper` | `SeatLifecycle` | Reaper applies a precomputed expired list with no re-check (`stale`): issue #40's trap | `SeatStatusAgrees` | 7 |
| `LifecycleStaleReaperExclusion` | `SeatLifecycle` | same mutation, checked at its consequence (a double claim) | `SeatBelongsToAtMostOne` | 8 |
| `CrashNoLookup` | `CrashRecovery` | retry path skips the key lookup; UNIQUE stays (`LookupMode = skip`) | `AmbiguousRetryNotRefused` | 8 |
| `CrashNoKeyDedupe` | `CrashRecovery` | no lookup and no UNIQUE on the key: two Bookings for one key (`KeyMode = none`) | `KeyAtMostOneBooking` | 9 |
| `CrashNoKeyDedupeHold` | `CrashRecovery` | same, for Holds | `KeyAtMostOneHold` | 9 |
| `CrashLoseCommitted` | `CrashRecovery` | a crash right after COMMIT un-commits the write (`CrashMode = loseCommitted`) | `CommittedPersists` | 6 |
| `CrashKeepLocks` | `CrashRecovery` | a crashed backend's row locks are never released (`keepLocks`) | `NoOrphanState` | 4 |
| `CrashKeepUncommitted` | `CrashRecovery` | the `seats` UPDATE of a crashed, uncommitted transaction survives (`keepUncommitted`) | `SeatStatusAgrees` | 5 |
| `CrashNoExpiryCheck` | `CrashRecovery` | Confirm skips the expiry check, re-run under Crash | `NoConfirmOnExpired` | 9 |

**Findings, violated on purpose (the behavior is real; see RF1/RF2)**

| Config | Module | Mutation / what it shows | Must violate | Trace (states) |
|---|---|---|---|---|
| `CrashFindingKeyReuse` | `CrashRecovery` | RF1: key lifetime equals row lifetime (book, cancel, retry the same key: a second Booking) | `BookingKeyCreatesAtMostOne` | 10 |
| `CrashFindingHoldKeyReuse` | `CrashRecovery` | RF1, Holds (hold, expire, reap, retry the same key: a second Hold) | `HoldKeyCreatesAtMostOne` | 11 |
| `CrashFindingSpuriousConflict` | `CrashRecovery` | RF2: a concurrent same-key retry is told 409 although the key's row is committed | `KeyNeverFalselyRefused` | 7 |

**Liveness controls (each differs from a passing twin in one assumption)**

| Config | Module | Mutation / what it shows | Must violate | Trace (states) |
|---|---|---|---|---|
| `LifecycleLiveNoFairness` | `SeatLifecycle` | no fairness at all: stuck with an expired `held` Hold | `temporal property violated` (exit 13) | 8 |
| `LifecycleLiveReaperDisabled` | `SeatLifecycle` | `ReaperMode = disabled`: nothing releases an expired Hold | `temporal property violated` (exit 13) | 7 |
| `LifecycleLiveNoTimeFairness` | `SeatLifecycle` | time never passes: a live Hold never expires | `temporal property violated` (exit 13) | 5 |
| `LifecycleLiveNoCommitFairness` | `SeatLifecycle` | an in-flight confirm never finishes | `temporal property violated` (exit 13) | 7 |
| `CrashLiveNoFairness` | `CrashRecovery` | no fairness: a retry may simply never start | `temporal property violated` (exit 13) | 9 |
| `CrashLiveKeepPending` | `CrashRecovery` | a crashed backend's in-flight key row is never released: the retry waits forever | `TLC: Deadlock reached` | 7 |

**Vacuity guards / witnesses (the interesting state is reachable)**

| Config | Module | Mutation / what it shows | Must violate | Trace (states) |
|---|---|---|---|---|
| `Witness` | `SeatBooking` | default model must reach a committed two-seat Booking alongside a conflict-aborted request | `NoContendedOutcome` | 7 |
| `DeadlockSortedWitness` | `DeadlockFreedom` | `sorted` must reach hold-and-wait (a request waiting while holding a lock) | `NoHoldAndWait` | 3 |
| `DeadlockNowaitWitness` | `DeadlockFreedom` | `nowait` must reach a contended abort alongside a committed request | `NoConflictAbort` | 4 |
| `LifecycleWitnessExpiryDuringConfirm` | `SeatLifecycle` | the TTL elapses while a confirm holds its row locks | `NoExpiryDuringConfirm` | 4 |
| `LifecycleWitnessConfirmWonAfterExpiry` | `SeatLifecycle` | a confirm that was live at its check commits on a Hold that is expired by then | `NoConfirmWonAfterExpiry` | 5 |
| `LifecycleWitnessReuseAfterReap` | `SeatLifecycle` | a reaped Hold's seat is claimed again | `NoReuseAfterReap` | 5 |
| `LifecycleWitnessBookingBlockedByHold` | `SeatLifecycle` | a direct booking loses to a live Hold | `NoBookingBlockedByHold` | 3 |
| `LifecycleWitnessCancelAfterConfirm` | `SeatLifecycle` | a confirmed Booking is cancelled | `NoCancelAfterConfirm` | 5 |
| `CrashWitnessAmbiguousCommit` | `CrashRecovery` | durable and unacknowledged is reachable (the Ambiguous outcome) | `NoAmbiguousCommit` | 6 |
| `CrashWitnessReplayAmbiguousBooking` | `CrashRecovery` | a retry replays an ambiguous Booking | `NoReplayAfterAmbiguousBooking` | 7 |
| `CrashWitnessReplayAmbiguousHold` | `CrashRecovery` | a retry replays an ambiguous Hold | `NoReplayAfterAmbiguousHold` | 7 |
| `CrashWitnessReplayAmbiguousConfirm` | `CrashRecovery` | a retried Confirm replays an ambiguous Confirm's Booking | `NoReplayAfterAmbiguousConfirm` | 11 |
| `CrashWitnessKeyRace` | `CrashRecovery` | the lookup-then-insert race ends in a unique violation resolved to a replay | `NoKeyRaceReplay` | 8 |
| `CrashWitnessWaitOnKeyRow` | `CrashRecovery` | an insert really waits on another transaction's in-flight same-key row | `NoWaitOnKeyRow` | 6 |
| `CrashWitnessUnblockedByCrash` | `CrashRecovery` | a waiter is released by the holder's crash before commit and then proceeds (a PROPERTY) | `temporal property violated` (exit 13) | 12 |
| `CrashWitnessSeatReuseAfterCrash` | `CrashRecovery` | a crash with locks held frees its seats for someone else | `NoSeatReuseAfterMidCrash` | 8 |
| `CrashWitnessConfirmCrashMidTxn` | `CrashRecovery` | a Confirm crashes holding the Hold's row locks | `NoConfirmCrashMidTxn` | 9 |
| `CrashWitnessReapAfterConfirmCrash` | `CrashRecovery` | ...and the Reaper then releases the Hold | `NoReapAfterConfirmCrash` | 11 |
| `CrashWitnessConfirmRetryAfterMidCrash` | `CrashRecovery` | ...and a retried Confirm then commits it | `NoRetryConfirmAfterMidCrash` | 12 |

How to read the four groups:

- **Controls** prove an invariant can fail. Each removes exactly one guard or assumption from an otherwise passing twin: no expiry check, no "still exists" check, an unguarded or stale Reaper, a missing key lookup, a missing UNIQUE constraint, a lost commit, a leaked lock, a surviving uncommitted write.
- **Findings** are invariants violated on purpose, because the behavior they name is *real* in the implementation. They are not failures of the model; they are the model reporting that a stronger-sounding statement ("a key creates at most one Booking, ever"; "a retried request is never wrongly refused") is not what the code does. They are RF1 and RF2 (Exhibit H; `docs/phase6-robustness-ticket-drafts.md`).
- **Liveness controls** each differ from a passing twin in exactly one *assumption* (no fairness; reaper disabled; time frozen; commits never finish). TLC does not print which property failed on exit 13, so `check.sh` asserts the exit code plus the TLC message and the traces were checked by hand to end in the corresponding stuck state (`formal/README.md`).
- **Vacuity guards** show the passing invariants are not passing on a model that never gets there: the default model really does reach a committed two-seat Booking next to a conflict-aborted request, `sorted` really does reach hold-and-wait, `nowait` really does lose a conflict while another request commits, the confirm-vs-expiry window really is reachable, a retry really does replay an ambiguous commit, and so on.

## Headline counterexamples, verbatim

Printed by `FORMAL_SHOW_TRACE=1 bash formal/check.sh --all` on this run (only TLC's header and initial-state noise is trimmed; the trace and statistics are unedited).

### 1. `NaiveMutualExclusion` — the unguarded read-then-write double-books (trace 7)

`ClaimMode = naive`: the availability read sees only *committed* rows and the write that follows is unconditional, with no unique backstop. That is `naive.ts` as it behaved before ADR-0008 (the state Exhibit A measured as a real double-booking under load). All three requests want `{s1}`:

1. `r1` starts, reads `s1` free (nothing committed) and becomes `active`.
2. `r1` writes its claim row for `s1`.
3. `r2` starts — `r1` has not committed, so its read of committed state still sees `s1` free — and becomes `active`. *This is the lost-update race.*
4. `r1` commits.
5. `r2` writes `s1` unconditionally; nothing re-checks.
6. `r2` commits. `MutualExclusion` is violated: two committed Bookings own `s1`.

```text
Error: Invariant MutualExclusion is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ todo = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ want = (r1 :> {s1} @@ r2 :> {s1} @@ r3 :> {s1})
/\ rows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ pc = (r1 :> "idle" @@ r2 :> "idle" @@ r3 :> "idle")

State 2: <Start line 66, col 5 to line 72, col 54 of module SeatBooking>
/\ todo = (r1 :> {s1} @@ r2 :> {} @@ r3 :> {})
/\ want = (r1 :> {s1} @@ r2 :> {s1} @@ r3 :> {s1})
/\ rows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ pc = (r1 :> "active" @@ r2 :> "idle" @@ r3 :> "idle")

State 3: <Next line 121, col 13 to line 121, col 50 of module SeatBooking>
/\ todo = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ want = (r1 :> {s1} @@ r2 :> {s1} @@ r3 :> {s1})
/\ rows = (r1 :> {s1} @@ r2 :> {} @@ r3 :> {})
/\ pc = (r1 :> "active" @@ r2 :> "idle" @@ r3 :> "idle")

State 4: <Start line 66, col 5 to line 72, col 54 of module SeatBooking>
/\ todo = (r1 :> {} @@ r2 :> {s1} @@ r3 :> {})
/\ want = (r1 :> {s1} @@ r2 :> {s1} @@ r3 :> {s1})
/\ rows = (r1 :> {s1} @@ r2 :> {} @@ r3 :> {})
/\ pc = (r1 :> "active" @@ r2 :> "active" @@ r3 :> "idle")

State 5: <Commit line 106, col 5 to line 109, col 37 of module SeatBooking>
/\ todo = (r1 :> {} @@ r2 :> {s1} @@ r3 :> {})
/\ want = (r1 :> {s1} @@ r2 :> {s1} @@ r3 :> {s1})
/\ rows = (r1 :> {s1} @@ r2 :> {} @@ r3 :> {})
/\ pc = (r1 :> "committed" @@ r2 :> "active" @@ r3 :> "idle")

State 6: <Next line 121, col 13 to line 121, col 50 of module SeatBooking>
/\ todo = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ want = (r1 :> {s1} @@ r2 :> {s1} @@ r3 :> {s1})
/\ rows = (r1 :> {s1} @@ r2 :> {s1} @@ r3 :> {})
/\ pc = (r1 :> "committed" @@ r2 :> "active" @@ r3 :> "idle")

State 7: <Commit line 106, col 5 to line 109, col 37 of module SeatBooking>
/\ todo = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ want = (r1 :> {s1} @@ r2 :> {s1} @@ r3 :> {s1})
/\ rows = (r1 :> {s1} @@ r2 :> {s1} @@ r3 :> {})
/\ pc = (r1 :> "committed" @@ r2 :> "committed" @@ r3 :> "idle")

31418 states generated, 15429 distinct states found, 5615 states left on queue.
The depth of the complete state graph search is 7.
The average outdegree of the complete state graph is 2 (minimum is 0, the maximum 5 and the 95th percentile is 3).
Finished in 00s at (2026-11-25 07:59:11)
```

### 2. `DeadlockUnsorted` — blocking acquisition in client order deadlocks (trace 3)

`AcqMode = unsorted`: each request acquires one lock per wanted seat, blocks if it is held, and keeps what it holds until commit, in the order the client sent `seat_ids`. This is `naive` / `unique_constraint` / `optimistic` / `serializable` *before* ADR-0014's sort. Here `r2` asks for seats `<<1, 2>>` and `r3` for `<<2, 1>>`; in `holder`, index *n* is seat *n*:

1. Initial state: nothing held.
2. `r2` acquires seat 1.
3. `r3` acquires seat 2. `r2` now waits on seat 2 (held by `r3`) and `r3` waits on seat 1 (held by `r2`): a wait-for cycle. `NoWaitForCycle` is violated, and (`DeadlockUnsortedStuck`, same state, trace 3) TLC's own stuck-state check independently reports `Deadlock reached`, so the cycle checker and a genuinely stuck state coincide.

This is the model of what Exhibit D measured for real as genuine `40P01` server errors on `INSERT INTO booking_seats ... SELECT unnest($ids)` against `booking_seats_seat_id_key`.

```text
Error: Invariant NoWaitForCycle is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ holder = <<"none", "none", "none">>
/\ order = (r1 :> <<1>> @@ r2 :> <<1, 2>> @@ r3 :> <<2, 1>>)
/\ idx = (r1 :> 0 @@ r2 :> 0 @@ r3 :> 0)
/\ pc = (r1 :> "active" @@ r2 :> "active" @@ r3 :> "active")

State 2: <Acquire line 80, col 5 to line 84, col 30 of module DeadlockFreedom>
/\ holder = <<r2, "none", "none">>
/\ order = (r1 :> <<1>> @@ r2 :> <<1, 2>> @@ r3 :> <<2, 1>>)
/\ idx = (r1 :> 0 @@ r2 :> 1 @@ r3 :> 0)
/\ pc = (r1 :> "active" @@ r2 :> "active" @@ r3 :> "active")

State 3: <Acquire line 80, col 5 to line 84, col 30 of module DeadlockFreedom>
/\ holder = <<r2, r3, "none">>
/\ order = (r1 :> <<1>> @@ r2 :> <<1, 2>> @@ r3 :> <<2, 1>>)
/\ idx = (r1 :> 0 @@ r2 :> 1 @@ r3 :> 1)
/\ pc = (r1 :> "active" @@ r2 :> "active" @@ r3 :> "active")

3264 states generated, 3171 distinct states found, 2284 states left on queue.
The depth of the complete state graph search is 3.
The average outdegree of the complete state graph is 3 (minimum is 1, the maximum 3 and the 95th percentile is 3).
Finished in 00s at (2026-11-25 07:59:15)
```

### 3. `CrashLoseCommitted` — a commit that does not survive a crash violates durability (trace 6)

`CrashMode = loseCommitted`: a crash right after `COMMIT` un-commits the write. Attempt `r1` books `{s1}` with key `k1`: it begins (the key lookup finds nothing), takes the row lock, inserts its key row, commits (`durable[r1] = TRUE`, `seat[s1] = "booked"`, `bookRows[r1] = {s1}`), and the backend dies before the acknowledgement — the Ambiguous outcome. In the mutated model the crash then clears the Booking and frees the seat (State 6: `bookRows` all empty, `seat[s1] = "available"`) although `durable[r1]` is still `TRUE` and nothing cancelled it. `CommittedPersists` — "whatever committed, acknowledged or ambiguous, is still there unless Cancel / Confirm / the Reaper removed it" — is violated.

This is the model's *assumption about Postgres* made visible. The real `CrashSafety` run passes because the clean model assumes a returned `COMMIT` is durable; this control proves the checker would notice if that assumption were wrong. **Whether the real server honors it across a crash-restart is not tested by either track** (chaos C4 was not run; see "What this does not prove").

```text
Error: Invariant CommittedPersists is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ prof = ( r1 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r2 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r3 :> [kind |-> "book", want |-> {s1}, key |-> k2, tgt |-> NoTgt] )
/\ cancelled = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ liveAtCheck = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ durable = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ bookRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ holdRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ nconf = (r1 :> 0 @@ r2 :> 0 @@ r3 :> 0)
/\ pc = (r1 :> "idle" @@ r2 :> "idle" @@ r3 :> "idle")
/\ pendKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ reaped = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ sawKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ solo = (r1 :> TRUE @@ r2 :> TRUE @@ r3 :> TRUE)
/\ seat = (s1 :> "available" @@ s2 :> "available" @@ s3 :> "available")
/\ expired = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ known = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ ncrash = 0
/\ crashedAt = (r1 :> "none" @@ r2 :> "none" @@ r3 :> "none")
/\ locked = (r1 :> {} @@ r2 :> {} @@ r3 :> {})

State 2: <Begin line 165, col 5 to line 176, col 81 of module CrashRecovery>
/\ prof = ( r1 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r2 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r3 :> [kind |-> "book", want |-> {s1}, key |-> k2, tgt |-> NoTgt] )
/\ cancelled = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ liveAtCheck = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ durable = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ bookRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ holdRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ nconf = (r1 :> 0 @@ r2 :> 0 @@ r3 :> 0)
/\ pc = (r1 :> "begun" @@ r2 :> "idle" @@ r3 :> "idle")
/\ pendKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ reaped = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ sawKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ solo = (r1 :> TRUE @@ r2 :> TRUE @@ r3 :> TRUE)
/\ seat = (s1 :> "available" @@ s2 :> "available" @@ s3 :> "available")
/\ expired = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ known = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ ncrash = 0
/\ crashedAt = (r1 :> "none" @@ r2 :> "none" @@ r3 :> "none")
/\ locked = (r1 :> {} @@ r2 :> {} @@ r3 :> {})

State 3: <Lock line 182, col 5 to line 191, col 79 of module CrashRecovery>
/\ prof = ( r1 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r2 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r3 :> [kind |-> "book", want |-> {s1}, key |-> k2, tgt |-> NoTgt] )
/\ cancelled = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ liveAtCheck = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ durable = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ bookRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ holdRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ nconf = (r1 :> 0 @@ r2 :> 0 @@ r3 :> 0)
/\ pc = (r1 :> "locked" @@ r2 :> "idle" @@ r3 :> "idle")
/\ pendKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ reaped = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ sawKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ solo = (r1 :> TRUE @@ r2 :> TRUE @@ r3 :> TRUE)
/\ seat = (s1 :> "available" @@ s2 :> "available" @@ s3 :> "available")
/\ expired = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ known = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ ncrash = 0
/\ crashedAt = (r1 :> "none" @@ r2 :> "none" @@ r3 :> "none")
/\ locked = (r1 :> {s1} @@ r2 :> {} @@ r3 :> {})

State 4: <InsertKey line 201, col 5 to line 212, col 72 of module CrashRecovery>
/\ prof = ( r1 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r2 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r3 :> [kind |-> "book", want |-> {s1}, key |-> k2, tgt |-> NoTgt] )
/\ cancelled = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ liveAtCheck = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ durable = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ bookRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ holdRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ nconf = (r1 :> 0 @@ r2 :> 0 @@ r3 :> 0)
/\ pc = (r1 :> "keyed" @@ r2 :> "idle" @@ r3 :> "idle")
/\ pendKey = (r1 :> TRUE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ reaped = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ sawKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ solo = (r1 :> TRUE @@ r2 :> TRUE @@ r3 :> TRUE)
/\ seat = (s1 :> "available" @@ s2 :> "available" @@ s3 :> "available")
/\ expired = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ known = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ ncrash = 0
/\ crashedAt = (r1 :> "none" @@ r2 :> "none" @@ r3 :> "none")
/\ locked = (r1 :> {s1} @@ r2 :> {} @@ r3 :> {})

State 5: <Commit line 218, col 5 to line 231, col 38 of module CrashRecovery>
/\ prof = ( r1 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r2 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r3 :> [kind |-> "book", want |-> {s1}, key |-> k2, tgt |-> NoTgt] )
/\ cancelled = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ liveAtCheck = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ durable = (r1 :> TRUE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ bookRows = (r1 :> {s1} @@ r2 :> {} @@ r3 :> {})
/\ holdRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ nconf = (r1 :> 0 @@ r2 :> 0 @@ r3 :> 0)
/\ pc = (r1 :> "unacked" @@ r2 :> "idle" @@ r3 :> "idle")
/\ pendKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ reaped = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ sawKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ solo = (r1 :> TRUE @@ r2 :> TRUE @@ r3 :> TRUE)
/\ seat = (s1 :> "booked" @@ s2 :> "available" @@ s3 :> "available")
/\ expired = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ known = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ ncrash = 0
/\ crashedAt = (r1 :> "none" @@ r2 :> "none" @@ r3 :> "none")
/\ locked = (r1 :> {} @@ r2 :> {} @@ r3 :> {})

State 6: <CrashAfterCommit line 336, col 5 to line 347, col 42 of module CrashRecovery>
/\ prof = ( r1 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r2 :> [kind |-> "book", want |-> {s1}, key |-> k1, tgt |-> NoTgt] @@
  r3 :> [kind |-> "book", want |-> {s1}, key |-> k2, tgt |-> NoTgt] )
/\ cancelled = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ liveAtCheck = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ durable = (r1 :> TRUE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ bookRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ holdRows = (r1 :> {} @@ r2 :> {} @@ r3 :> {})
/\ nconf = (r1 :> 0 @@ r2 :> 0 @@ r3 :> 0)
/\ pc = (r1 :> "crashed" @@ r2 :> "idle" @@ r3 :> "idle")
/\ pendKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ reaped = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ sawKey = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ solo = (r1 :> TRUE @@ r2 :> TRUE @@ r3 :> TRUE)
/\ seat = (s1 :> "available" @@ s2 :> "available" @@ s3 :> "available")
/\ expired = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ known = (r1 :> FALSE @@ r2 :> FALSE @@ r3 :> FALSE)
/\ ncrash = 1
/\ crashedAt = (r1 :> "none" @@ r2 :> "none" @@ r3 :> "none")
/\ locked = (r1 :> {} @@ r2 :> {} @@ r3 :> {})

43957 states generated, 15038 distinct states found, 7574 states left on queue.
The depth of the complete state graph search is 6.
The average outdegree of the complete state graph is 2 (minimum is 0, the maximum 6 and the 95th percentile is 4).
Finished in 01s at (2026-11-25 07:59:57)
```

## The deadlock A/B result

`DeadlockFreedom.tla` models what `SeatBooking.tla` abstracts away: a lock that is already held makes the next requester *wait*. A "lock" stands for whatever a mechanism blocks on — a `seats` row lock or an in-flight unique-index entry; Exhibit D showed the real `naive` cycle was on the latter, and the model deliberately does not care which. Acquisition mode is the only variable:

| `AcqMode` | Behavior | Result (3 requests, 3 seats, sets ≤ 2) |
|---|---|---|
| `unsorted` | block, in the order the client sent `seat_ids` | **cycle** — `DeadlockUnsorted`, 3 states; TLC's stuck-state check agrees (`DeadlockUnsortedStuck`) |
| `sorted` | block, in ascending seat order | **no cycle, no stuck state** — `DeadlockSorted`, 11,046 states generated, 6,876 distinct. `DeadlockSortedWitness` shows it still reaches hold-and-wait, so it is not clean for lack of contention |
| `nowait` | never block: a held lock aborts the request and releases what it holds | **cycle-free, no stuck state** — `DeadlockNowait`, 89,577 generated, 54,531 distinct, with acquisition order still client-chosen. `DeadlockNowaitWitness` shows contention really happens (a conflict abort alongside a commit) |

**Why `sorted` works.** If request A waits on seat `s` held by B, everything A already holds is below `s` (A's next seat is its smallest not-yet-taken one); if B in turn waits on `t`, then `t` is above `s` (B holds `s`). Each hop along a wait-for chain waits on a strictly higher seat, so a chain can never close into a cycle. That is the informal argument; the `sorted` row checks it exhaustively, for the abstract protocol. It corresponds to ADR-0014's primary defense: `normalizeSeatIds` sorts `seat_ids` before any write (`naive`, `unique_constraint`, `optimistic`, `serializable` all call it; rows in the mapping table below). Any total order every request agrees on would do; `normalizeSeatIds` uses lowercase-then-ordinal sort rather than `localeCompare` precisely so two processes cannot disagree (`idempotency.ts:6-13`).

**Why `pessimistic` and `advisory` are deadlock-free by construction (ADR-0006).** A deadlock needs hold-and-wait: a request holds a lock *and waits* for another. `SELECT ... FOR UPDATE NOWAIT` and `pg_try_advisory_xact_lock` never wait: a held lock fails the attempt at once (HTTP 409) and the transaction rolls back everything it took. The wait-for graph has no edges, so it has no cycles, whatever order the seats arrive in. That is why `nowait` takes the *unsorted* orderings in the model — freedom does not come from ordering. ADR-0006 chose NOWAIT for FR1's "409 immediately"; deadlock freedom is a side effect, and `pessimistic.ts` / `advisory.ts` sorting `seat_ids` anyway (issue #30) is uniformity, not necessity. Because `nowait` is trivially cycle-free on the cycle checker, its check is only meaningful next to its stuck-state check and its vacuity guard.

**What the A/B does not cover.** The *implementation* of the sort (mapping table: the call sites exist and sort before the write; that the sorted order is the order the `INSERT ... unnest()` acquires index entries is ADR-0016's measured claim, not re-derived here); the fallback layer (`withDeadlockRetry`, `serializable`'s extended retry loop, `retry_exhausted`, ADR-0014/0015) — the model has no deadlock detector and no aborts in the blocking modes, so `sorted` shows the fallback is never *needed* in the abstract protocol, not that it *works*; locks Postgres takes that the model has no seat for; and requests running mixed old and new code.

## Spec action → SQL mapping

Audited at commit `d3f972b` (tree of `src/`, `db/schema.sql` and `formal/` identical to the commit that adds this exhibit). The mapping is **hand-audited**: I read each spec action against the code that implements it and recorded where they correspond and where the spec is coarser. It is **not trace-validated** — no tool checks that the code's behaviour is one the spec allows.

Because line numbers rot, the table is guarded by `test/formalMapping.test.ts` (no database needed; runs in `npm test`). The test parses this very table and, for every row, asserts that the cited file exists, that the row's **anchor** (a short literal snippet, in the third column) still appears in it, and that it appears within 4 lines of the cited line(s); it also asserts that every action in each spec's `Next` has a row and that every `Module.Action` named below still exists in its `.tla` file. A failure of the first kind means the code the row describes was rewritten — **re-audit the row, do not just edit the snippet**; a failure of the second means the code only moved — update the line number. What it cannot detect: a semantic change that keeps the anchor in place. To see what changed since the audit: `git diff d3f972b -- src db`.

Column 4 states every place the spec is **coarser than the code**, which is the thing a reader needs to price the proof. Abbreviations: `P` = `src/strategies/pessimistic.ts`, `PH` = `pessimisticHold.ts`, `PC` = `pessimisticConfirm.ts`, `I` = `idempotency.ts` (the `file:line` column always gives the full path). *(env)* marks a row whose spec action is an environment event or a negative-control mutation with no production counterpart.

<!-- mapping:begin -->
| Spec action | Code | Anchor | Where the spec is coarser than the code |
|---|---|---|---|
| `SeatBooking.Start` | `src/db/pool.ts:41` | `await client.query("BEGIN");` | Spec: the request becomes `active` in one step. Code: `withTransaction` opens the transaction on a checked-out pool client. The `naive` branch of `Start` (availability read) is a control with no counterpart |
| `SeatBooking.AtomicClaim` (claim succeeds) | `src/strategies/pessimistic.ts:38` | `SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE NOWAIT` | Spec claims **one seat per step**, in any order, and aborts at the first taken seat; the code locks the **whole sorted set in one statement** (NOWAIT fails the statement if any row is locked). The single statement is one of the spec's interleavings, so the spec's behaviours are a superset. The spec also merges "lock" and "is `available`"; the code does them in two steps (:38 then :69) with the row lock held between them, which is what makes the pair atomic |
| `SeatBooking.AtomicClaim` (taken: lock held) | `src/strategies/pessimistic.ts:42` | `if (isLockNotAvailable(err)) {` | `55P03` is caught inside `work`, which then runs a **non-locking existence check on another connection** (:54) to choose 404 vs 409; the spec has no unknown seats (`not_found` is not modelled), only `conflict`. See audit observation O1: this losing attempt **did** lock the rows it could reach |
| `SeatBooking.AtomicClaim` (taken: not `available`) | `src/strategies/pessimistic.ts:69` | `seat.status !== "available"` | Same: the spec's `~Avail` abort. In the code the rows are row-locked until the `ROLLBACK` (O1) |
| `SeatBooking.Abort` | `src/db/pool.ts:44` | `shouldCommit(result) ? "COMMIT" : "ROLLBACK"` | The spec's `Abort` is this `ROLLBACK` for a `conflict` / `not_found` result (`shouldCommit` is false). The catch-block `ROLLBACK` for thrown errors (:47) is the crash-adjacent path, see `CrashRecovery.Crash` |
| `SeatBooking.Commit` | `src/db/pool.ts:44` | `shouldCommit(result) ? "COMMIT" : "ROLLBACK"` | Spec `Commit` makes `rows[r]` visible instantly. Code: `COMMIT` of a three-statement transaction; under READ COMMITTED none of its row changes is visible to others until it returns, which is the instant the spec models |
| `SeatBooking.Commit` (the claim rows) | `src/strategies/idempotency.ts:194` | `INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])` | This is `rows[r]`. `insertBookingForSeats` is shared by direct booking (`P:73`) and confirm (`PC:133`). The spec has no `bookings` row or key here (F4 adds it) |
| `SeatBooking.Commit` (the seat status) | `src/strategies/idempotency.ts:199` | `UPDATE seats SET status = 'booked', booked_by = $1, held_until = NULL, version = version + 1 WHERE id = ANY($2)` | `SeatBooking` has no `seats.status`; `SeatLifecycle` / `CrashRecovery` model it as `seat[s]`. `version`, `booked_by` are not modelled |
| `SeatBooking.NaiveWrite` *(env: control)* | `src/strategies/naive.ts:76` | `INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])` | The control is `naive.ts` **before** ADR-0008. That version no longer exists in `src/`: today the same insert is caught by the UNIQUE backstop below and returns 409. Exhibit A holds the live "before" evidence |
| `SeatBooking.NaiveWrite` *(env: what the control removes)* | `db/schema.sql:51` | `seat_id UUID NOT NULL REFERENCES seats (id) UNIQUE` | ADR-0008's backstop. `ClaimMode = naive` is "no such constraint"; every mechanism in `src/` has it, so the real `naive` is **not** the model's `naive` |
| `SeatBooking.PartialClaim` *(env: control)* | `src/strategies/uniqueConstraint.ts:57` | `ON CONFLICT (seat_id) DO NOTHING` | Not a mechanism in `src/`: the spec **ignores** the affected-row count, so a request commits whichever seats it won. The real code checks it (next row) |
| `SeatBooking.PartialClaim` *(env: what the control omits)* | `src/strategies/uniqueConstraint.ts:61` | `insertRes.rowCount !== seatIds.length` | The all-or-nothing check `partial` leaves out. Also: `ON CONFLICT DO NOTHING` **waits** on an in-flight conflicting insert instead of failing fast (O2) |
| `DeadlockFreedom.Acquire` (`nowait`: row lock) | `src/strategies/pessimistic.ts:38` | `SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE NOWAIT` | The model acquires **one lock per step**; the code takes the set in one statement. Not-waiting is what the `nowait` mode captures, and it is exact for this statement |
| `DeadlockFreedom.Acquire` (`nowait`: advisory) | `src/strategies/advisory.ts:48` | `pg_try_advisory_xact_lock(hashtext(id::text))` | `advisory` has no spec of its own; this row records that its try-lock is the same non-waiting shape. The `hashtext` → lock-key mapping (ADR-0010) is outside the model |
| `DeadlockFreedom.Fail` (`nowait`: row lock) | `src/strategies/pessimistic.ts:42` | `if (isLockNotAvailable(err)) {` | Spec `Fail` aborts and releases at once; code returns `conflict`, and `withTransaction` then `ROLLBACK`s (`pool.ts:44`) |
| `DeadlockFreedom.Fail` (`nowait`: advisory) | `src/strategies/advisory.ts:58` | `!seat.acquired` | As above, for `pg_try_advisory_xact_lock` returning false |
| `DeadlockFreedom.Acquire` (what is blocked on: `unsorted` / `sorted`) | `src/strategies/naive.ts:76` | `INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])` | The lock is a unique-index entry on `booking_seats_seat_id_key`, taken in **array order** (`unnest` preserves it) — Exhibit D / ADR-0016. The `UPDATE seats ... ANY($ids)` that follows is plan-ordered, so ADR-0016 argues it cannot deadlock either way; the model has no seat for it and this is **not re-derived** |
| `DeadlockFreedom.Acquire` (`sorted`: the sort) | `src/strategies/idempotency.ts:15` | `return seatIds.map((seatId) => seatId.toLowerCase()).sort();` | The spec's `Ascending(q)`. Needs only that every request uses the **same** total order; ordinal sort of lowercase text is deterministic across processes (unlike `localeCompare`) |
| `DeadlockFreedom.Acquire` (`sorted`: call site `naive`) | `src/strategies/naive.ts:42` | `normalizeSeatIds(input.seatIds)` | Sorted before any write. The model's "sorted" is true only for requests that went through this; a code path that writes before sorting would not be covered |
| `DeadlockFreedom.Acquire` (`sorted`: call site `unique_constraint`) | `src/strategies/uniqueConstraint.ts:30` | `normalizeSeatIds(input.seatIds)` | as above |
| `DeadlockFreedom.Acquire` (`sorted`: call site `optimistic`) | `src/strategies/optimistic.ts:90` | `normalizeSeatIds(input.seatIds)` | as above; the CAS-retry loop is not modelled |
| `DeadlockFreedom.Acquire` (`sorted`: call site `serializable`) | `src/strategies/serializable.ts:44` | `normalizeSeatIds(input.seatIds)` | as above; SSI is not modelled |
| `DeadlockFreedom.Commit` | `src/db/pool.ts:184` | `shouldCommit(result) ? "COMMIT" : "ROLLBACK"` | This is `withDeadlockRetry`'s commit. The **loop around it** (retry on `40P01`, backoff, cap) is the fallback the model deliberately omits (see "not modelled" table) |
| `SeatLifecycle.AcquireHold` (lock) | `src/strategies/pessimisticHold.ts:39` | `SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE NOWAIT` | Spec: one atomic all-or-nothing step (justified by F1's `ClaimMode = atomic` result). Code: the F1 claim, then three writes |
| `SeatLifecycle.AcquireHold` (fails: lock held) | `src/strategies/pessimisticHold.ts:43` | `if (isLockNotAvailable(err)) {` | Spec: `hold_failed`, nothing changes. Code: 409 after the same fallback existence check as `P:54`; locks taken by the failed attempt are held until its `ROLLBACK` (O1) |
| `SeatLifecycle.AcquireHold` (fails: not `available`) | `src/strategies/pessimisticHold.ts:65` | `seat.status !== "available"` | Spec: a seat `held` by a live Hold, or `booked`, fails the request. An **expired but not yet reaped** Hold still has `status = 'held'`, so it also blocks a new hold until the Reaper runs; the spec matches (expiry changes only the `expired` flag) |
| `SeatLifecycle.AcquireHold` (writes: `holds` row) | `src/strategies/pessimisticHold.ts:70` | `INSERT INTO holds (idempotency_key) VALUES ($1) RETURNING id` | The spec has no `holds` row in F3 (F4 has it as the key row) |
| `SeatLifecycle.AcquireHold` (writes: `hold_seats`) | `src/strategies/pessimisticHold.ts:75` | `INSERT INTO hold_seats (hold_id, seat_id) SELECT $1, unnest($2::uuid[])` | This is `holdRows[r]` |
| `SeatLifecycle.AcquireHold` (writes: seat status and deadline) | `src/strategies/pessimisticHold.ts:86` | `SET status = 'held', booked_by = $1, held_until = now() + $2::interval, version = version + 1` | `seat[s] = "held"`. The deadline is DB `now()` + a constant TTL; the spec has no clock, only the monotonic flag `expired[r]` |
| `SeatLifecycle.DirectBook` | `src/strategies/pessimistic.ts:73` | `insertBookingForSeats(txClient, seatIds, input.userId, input.idempotencyKey)` | Same acquisition as `AcquireHold` (`P:38`), then straight to `booked`. The `INSERT`/`UPDATE` are the `Commit` rows above |
| `SeatLifecycle.Expire` *(env)* | `src/strategies/pessimisticHold.ts:86` | `held_until = now() + $2::interval` | Expire is time passing: **no statement implements it.** This is where the deadline is set; the three readers are confirm's app-clock check (`PC:113`), the Reaper's DB-clock predicate (`reaper.ts:37`) and the replay path, which never checks it (O3) |
| `SeatLifecycle.ConfirmLock` (locks) | `src/strategies/pessimisticConfirm.ts:67` | `FOR UPDATE OF s NOWAIT` | The hold's rows are read **and** locked in one `JOIN` statement (the fix for the two-query gap found in issue #39's review), so there is no window between "the Hold exists" and "its seats are locked" |
| `SeatLifecycle.ConfirmLock` (a concurrent confirm: 409) | `src/strategies/pessimisticConfirm.ts:71` | `if (isLockNotAvailable(err)) {` | Spec: a failing confirm is a stutter (not an enabled step). Code returns `conflict` / 409, **mapped for any `55P03`**, not only a genuine concurrent confirm: see O1 |
| `SeatLifecycle.ConfirmLock` (the lazy expiry check) | `src/strategies/pessimisticConfirm.ts:113` | `heldUntil.getTime() <= Date.now()` | Spec: one flag. Code: **app clock** at confirm vs **DB clock** in the Reaper, and `<=` here vs `<` there (at equality neither acts until the next sweep). Cross-clock skew is not represented |
| `SeatLifecycle.ConfirmLock` (hold gone: replay or 404) | `src/strategies/pessimisticConfirm.ts:79` | `seatRes.rows.length === 0` | Spec: a stutter for `held` only. The in-transaction fallback key lookup (:88) is modelled only in F4 (`CLockGone`) |
| `SeatLifecycle.ConfirmCommit` (booking and key) | `src/strategies/pessimisticConfirm.ts:133` | `insertBookingForSeats(txClient, seatIds, userId, idempotencyKey)` | One transaction in the code: `insertBookingForSeats` + the teardown below + `COMMIT`. The spec does not re-check expiry here (the row locks make the check-time answer stand until commit) |
| `SeatLifecycle.ConfirmCommit` (hold teardown) | `src/strategies/pessimisticConfirm.ts:141` | `WITH deleted_hold_seats AS (DELETE FROM hold_seats WHERE hold_id = $1) DELETE FROM holds WHERE id = $1` | `holdRows[r] = {}`. Child before parent in one statement (ADR-0020, no CASCADE) |
| `SeatLifecycle.ConfirmCommit` (commit only on `created`) | `src/strategies/pessimisticConfirm.ts:147` | `(result) => result.kind === "created"` | A confirm that returned `conflict` / `expired` / `not_found` / replay is rolled back, which is why the spec treats those as stutters |
| `SeatLifecycle.Reap` (the guard) | `src/reaper.ts:37` | `WHERE status = 'held' AND held_until < now()` | Spec: **one atomic step per Hold**, enabled only for an expired `held` Hold that no in-flight confirm has locked. Code: **one chained-CTE statement over every expired seat**; a row locked by a confirm makes the `UPDATE` **block** (not NOWAIT), then Postgres's re-check (EPQ) finds it `booked` and skips it. The spec's "not enabled while `confirming`" is that blocking. What the spec cannot see: while blocked, the statement already holds row locks on the *other* expired seats it updated (R7, Exhibit H) |
| `SeatLifecycle.Reap` (seat reset) | `src/reaper.ts:36` | `SET status = 'available', booked_by = NULL, held_until = NULL, version = version + 1` | `seat[s] = "available"` for the Hold's seats |
| `SeatLifecycle.Reap` (hold_seats delete) | `src/reaper.ts:41` | `DELETE FROM hold_seats WHERE seat_id IN (SELECT id FROM expired) RETURNING hold_id` | `holdRows[r] = {}`. The id list is the first CTE's own `RETURNING` — only rows this statement **really** updated, after the re-check |
| `SeatLifecycle.Reap` (holds delete) | `src/reaper.ts:43` | `DELETE FROM holds WHERE id IN (SELECT hold_id FROM deleted_hold_seats)` | One atomic statement, no explicit transaction. A sweep is *only* the three CTEs; `startReaper`'s timer is not modelled (below) |
| `SeatLifecycle.SnapReap`, `SeatLifecycle.ApplyReap` *(env: control)* | `src/reaper.ts:41` | `DELETE FROM hold_seats WHERE seat_id IN (SELECT id FROM expired) RETURNING hold_id` | `ReaperMode = stale` is issue #40's trap: a candidate list computed in an earlier read and applied later with no re-check. The shipped statement is the opposite shape (the list comes from the same statement's `RETURNING`); that the model's `stale` fails and `guarded` passes is what justifies writing the sweep this way |
| `SeatLifecycle.Cancel` (booking_seats) | `src/routes/bookings.ts:61` | `DELETE FROM booking_seats WHERE booking_id = $1 RETURNING seat_id` | `bookRows[r] = {}`. Cancel is implemented once for every mechanism |
| `SeatLifecycle.Cancel` (seat status) | `src/routes/bookings.ts:71` | `UPDATE seats SET status = 'available', booked_by = NULL, version = version + 1 WHERE id = ANY($1)` | A **blocking** `UPDATE` (no NOWAIT): it can wait behind another transaction's lock on the same rows (O1). Spec: atomic |
| `SeatLifecycle.Cancel` (bookings row) | `src/routes/bookings.ts:74` | `DELETE FROM bookings WHERE id = $1` | Deleting the row deletes the **idempotency key with it** (ADR-0020) — the cause of RF1 |
| `CrashRecovery.Begin` (book: fast-path lookup) | `src/strategies/pessimistic.ts:25` | `findExistingBookingByIdempotencyKey(client, input.idempotencyKey)` | Runs on the checked-out client **before `BEGIN`** (autocommit): sees committed rows only. Spec: one atomic step. This pre-`BEGIN` placement is RF2 |
| `CrashRecovery.Begin` (hold: fast-path lookup) | `src/strategies/pessimisticHold.ts:20` | `findExistingHoldByIdempotencyKey(client, input.idempotencyKey)` | as above. A replay returns the Hold **whatever its expiry** (O3) |
| `CrashRecovery.Begin` (confirm: fast-path lookup) | `src/strategies/pessimisticConfirm.ts:42` | `findExistingBookingByIdempotencyKey(client, idempotencyKey)` | The key is synthesized from the Hold id (next row) |
| `CrashRecovery.Begin` (confirm: the synthesized key) | `src/strategies/pessimisticConfirm.ts:22` | `hold-confirm:${holdId}` | Prefixed so it can never equal a client key (issue #39's review). Spec's `SameBKey` encodes "two confirms of one Hold share a key, and it differs from every client key" |
| `CrashRecovery.Begin` (the lookup SQL, bookings) | `src/strategies/idempotency.ts:32` | `SELECT id, created_at FROM bookings WHERE idempotency_key = $1` | `KeyCommitted(r)` for Bookings |
| `CrashRecovery.Begin` (the lookup SQL, holds) | `src/strategies/idempotency.ts:130` | `WHERE h.idempotency_key = $1` | `KeyCommitted(r)` for Holds. Joins `hold_seats` and `seats`, so a `holds` row with no `hold_seats` row would not count; they are written in one transaction, so the spec treats them as one |
| `CrashRecovery.Lock` (book) | `src/strategies/pessimistic.ts:38` | `SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE NOWAIT` | Spec: a seat locked by another **open** transaction, or not `available`, gives 409. Locks held by *any* transaction count in the code (confirm, cancel, the reaper, a losing attempt: O1); the spec counts only other attempts' `locked` sets |
| `CrashRecovery.Lock` (hold) | `src/strategies/pessimisticHold.ts:39` | `SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE NOWAIT` | as above |
| `CrashRecovery.InsertKey` (book) | `src/strategies/idempotency.ts:189` | `INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at` | An uncommitted same-key row **blocks** this insert (unique-index wait); a committed one raises a unique violation. The spec's `~pendKey` guard / `race_replay` branch |
| `CrashRecovery.InsertKey` (hold) | `src/strategies/pessimisticHold.ts:70` | `INSERT INTO holds (idempotency_key) VALUES ($1) RETURNING id` | as above |
| `CrashRecovery.InsertKey` (UNIQUE on bookings) | `db/schema.sql:41` | `idempotency_key TEXT NOT NULL UNIQUE` | `KeyMode = unique`. Deleting this is the `CrashNoKeyDedupe` control |
| `CrashRecovery.InsertKey` (UNIQUE on holds) | `db/schema.sql:61` | `idempotency_key TEXT NOT NULL UNIQUE` | `CrashNoKeyDedupeHold` |
| `CrashRecovery.InsertKey` (race → replay, bookings) | `src/strategies/idempotency.ts:54` | `isUniqueViolation(err, "bookings_idempotency_key_key")` | The spec's `race_replay`. Under `pessimistic` this path is reachable only for a same-key retry wanting **different** seats (`CrashWitnessKeyRace`) |
| `CrashRecovery.InsertKey` (race → replay, wired) | `src/strategies/idempotency.ts:77` | `return await resolveIdempotencyKeyRace(client, idempotencyKey, err);` | Hooked in `runTransactionalBooking`'s catch, **after** `withTransaction`'s own `ROLLBACK` |
| `CrashRecovery.InsertKey` (race → replay, holds) | `src/strategies/idempotency.ts:145` | `isUniqueViolation(err, "holds_idempotency_key_key")` | Hold counterpart; wired at `idempotency.ts:168` |
| `CrashRecovery.Commit` | `src/db/pool.ts:44` | `shouldCommit(result) ? "COMMIT" : "ROLLBACK"` | **The durability line.** Spec: the rows and the `seats` update become visible together and are durable from here (`CommittedPersists`, assumed, falsifiable by the `CrashLoseCommitted` control, not tested against a real restart) |
| `CrashRecovery.Ack` (book) | `src/routes/bookings.ts:23` | `reply.status(201).send({ id: result.bookingId, created_at: result.createdAt });` | The 201 reaching the client. Whether the response leaves the process is outside the model (the Ambiguous outcome) |
| `CrashRecovery.Ack` (hold) | `src/routes/holds.ts:28` | `reply.status(201).send({ id: result.holdId, seat_ids: result.seatIds, held_until: result.heldUntil });` | Also teaches the client the Hold id (`known[]`): confirm needs it, and there is no `GET /holds/{id}` |
| `CrashRecovery.CLock` (outcome Conflict) | `src/strategies/pessimisticConfirm.ts:71` | `if (isLockNotAvailable(err)) {` | `CLockConflict` requires another attempt's `locked` set to intersect the Hold's seats; the code maps any `55P03` (O1) |
| `CrashRecovery.CLock` (outcome Gone: replay or 404) | `src/strategies/pessimisticConfirm.ts:88` | `findExistingBookingByIdempotencyKey(txClient, idempotencyKey)` | `CLockGone`: the **in-transaction** repeat of the key lookup, after the locks, which is why a confirm is never falsely refused (`ConfirmNeverFalselyRefused`) while the book/hold paths are (RF2) |
| `CrashRecovery.CLock` (outcome Expired) | `src/strategies/pessimisticConfirm.ts:113` | `heldUntil.getTime() <= Date.now()` | `CLockExpired`: HTTP 410. App clock (above) |
| `CrashRecovery.CLock` (outcome Ok) | `src/strategies/pessimisticConfirm.ts:67` | `FOR UPDATE OF s NOWAIT` | `CLockOk`: row locks held (`pc = clocked`) |
| `CrashRecovery.CCommit` (booking) | `src/strategies/pessimisticConfirm.ts:133` | `insertBookingForSeats(txClient, seatIds, userId, idempotencyKey)` | `bookRows[r]`, key `hold-confirm:<id>`; no unique violation is reachable (the Hold's row locks serialize confirms) |
| `CrashRecovery.CCommit` (teardown) | `src/strategies/pessimisticConfirm.ts:141` | `WITH deleted_hold_seats AS (DELETE FROM hold_seats WHERE hold_id = $1) DELETE FROM holds WHERE id = $1` | `holdRows[Tgt] = {}`; the Hold's key is gone with the row (RF1 for Holds) |
| `CrashRecovery.Crash` (before COMMIT) *(env)* | `src/db/pool.ts:47` | `await client.query("ROLLBACK");` | No code implements a crash. Postgres rolling back a dead backend's transaction and releasing its locks is an **assumption** (`NoOrphanState`; controls `CrashKeepLocks`, `CrashKeepUncommitted`) and what chaos Oracle 4 and C1/C3 test. This catch-block `ROLLBACK` is the app's own attempt; on a dead connection it throws and **masks the original error** (R3, Exhibit H) — not modelled |
| `CrashRecovery.Crash` (after COMMIT: the Ambiguous outcome) *(env)* | — | — | No code and no anchor: the ack is lost in the network or process, not in a statement. Recovery is the `Begin` lookup rows above; the controls are `CrashNoLookup`, `CrashLoseCommitted` |
| `CrashRecovery.Expire` *(env)* | `src/strategies/pessimisticHold.ts:86` | `held_until = now() + $2::interval` | as `SeatLifecycle.Expire` |
| `CrashRecovery.Reap` | `src/reaper.ts:37` | `WHERE status = 'held' AND held_until < now()` | as `SeatLifecycle.Reap`; the spec additionally refuses to reap while a confirm is `clocked` |
| `CrashRecovery.Cancel` | `src/routes/bookings.ts:61` | `DELETE FROM booking_seats WHERE booking_id = $1 RETURNING seat_id` | as `SeatLifecycle.Cancel`; deletes the key with the row (RF1) |
<!-- mapping:end -->

### Code the specs do not model

The same drift test covers these rows. Each is code in the cited files that no spec action describes; listing them keeps the table honest about what the proof does *not* touch.

<!-- mapping:begin -->
| Spec action | Code | Anchor | What is not modelled |
|---|---|---|---|
| (not modelled) deadlock fallback | `src/db/pool.ts:178` | `const maxRetries = options.maxRetries ?? config.deadlockMaxRetries;` | `withDeadlockRetry` (ADR-0014): retry from `BEGIN` on `40P01`, jittered backoff, cap. `DeadlockSorted` shows it is never needed in the abstract protocol, not that it works |
| (not modelled) serializable retry | `src/db/pool.ts:135` | `if (!isSerializationFailure(err) && !isDeadlockDetected(err)) {` | `withSerializableTransaction`'s loop (ADR-0011, `40001` and `40P01`) |
| (not modelled) retry exhaustion | `src/strategies/idempotency.ts:101` | `return { kind: "retry_exhausted", retries: err.retries };` | HTTP 503 (ADR-0012/0015). No spec has a bounded-retry outcome |
| (not modelled) unknown seats | `src/strategies/pessimistic.ts:54` | `SELECT 1 FROM seats WHERE id = ANY($1)` | 404-vs-409 disambiguation on a losing attempt. The specs have no unknown seat ids |
| (not modelled) defensive confirm branch | `src/strategies/pessimisticConfirm.ts:95` | `seat.status !== "held"` | Unreachable given the combined `JOIN` (issue #39's review); a belt-and-braces replay-or-404 |
| (not modelled) the Reaper as a process | `src/reaper.ts:60` | `const interval = setInterval(() => {` | The sweep *timer*: a failed sweep is logged and retried next tick. The spec's `Reap` has no cadence; liveness assumes weak fairness on it |
| (not modelled) malformed ids | `src/routes/holds.ts:52` | `isInvalidTextRepresentation(err)` | A non-UUID hold id is a 404 via `22P02`; the specs' ids are always well-formed |
<!-- mapping:end -->

### Audit observations

Reading the specs against the code turned up the following. None breaks a checked invariant — none is a Correctness violation — and **none was fixed**: this ticket changes no production code and no spec. They are reported so the reader knows where the abstraction is looser than it looks.

- **O1 — a losing attempt briefly row-locks seats it will not get, which the specs cannot represent.** `FOR UPDATE NOWAIT` locks every row the statement returns; the `available` check happens *after* (`pessimistic.ts:38` then `:69`; `pessimisticHold.ts:39` then `:65`), and the lock is released only when `withTransaction` rolls back (`pool.ts:44`). So a booking or hold attempt on a seat that is already `held` or `booked` holds that seat's row lock for about one round trip. In that window a `POST /holds/{id}/confirm` of the Hold on that seat gets `55P03` and is answered **409 "Hold is being confirmed by another request"** (`pessimisticConfirm.ts:71-74`) although no other confirm exists; the Reaper's `UPDATE` and `DELETE /bookings/{id}`'s `UPDATE` block behind it. The spec's failing branch (`AtomicClaim` abort, `AcquireHold`/`DirectBook` failure, `CrashRecovery.Lock` conflict) takes **no** lock. Consequence for the proof: none of the checked properties changes — a refused confirm changes no state, and `SeatLifecycle` treats every refused confirm as a stutter, which covers this — and `ConfirmNeverFalselyRefused` is about a confirm refused *while its key's Booking exists*, which cannot happen here (a finished confirm's `hold_seats` rows are gone, so the `JOIN` locks nothing). It does mean the model *understates* spurious 409s on confirm under same-seat contention. Established by reading the SQL and Postgres's locking semantics; **not reproduced by a run** (the shared Postgres was not used for this ticket). A deterministic test would hold a booking attempt's transaction open between the `SELECT` and the `ROLLBACK` and call confirm.
- **O2 — `unique_constraint` is not a fail-fast claim.** `formal/README.md` describes `ClaimMode = atomic` as modelling both `FOR UPDATE NOWAIT` and "the unique-index entry of an in-flight `INSERT … ON CONFLICT`". The first is exact. For the second the *outcome* (exactly one winner, all-or-nothing) is the same, but the real `ON CONFLICT DO NOTHING` **waits** on an in-flight conflicting insert until its transaction ends, then skips or proceeds, rather than aborting immediately as `atomic` does; the blocking is F2's `unsorted`/`sorted` territory and `uniqueConstraint.ts:30` sorts first. This is out of the four files this ticket maps (`unique_constraint` has no row in the lifecycle or crash models), so it is a note on the README's wording, not a defect in a checked claim. Not edited.
- **O3 — replaying a Hold does not check its expiry.** `holdSeatsPessimistic` returns an existing Hold for a repeated key with 201 regardless of whether its `held_until` has passed (`pessimisticHold.ts:20-28`, `idempotency.ts:121-136`). The model replays whatever exists, so it matches the code; the safety consequence is nil because `Confirm` re-checks expiry. It is worth stating because a client that gets 201 on a retry may be holding an expired Hold.

Also confirmed by the audit, already known: the pre-`BEGIN` key lookup and its consequence (**RF2**, `pessimistic.ts:25`, `pessimisticHold.ts:20`; the confirm path repeats it inside the transaction at `pessimisticConfirm.ts:88`, which is why confirm is immune); the key living exactly as long as its row (**RF1**, `routes/bookings.ts:74`, `pessimisticConfirm.ts:141`, `reaper.ts:43`); the stalled-reaper effect the one-step-per-Hold abstraction hides (**R7**).

## What this does not prove

Read this next to Exhibit H's "What this does not show"; the two lists are complementary.

1. **A small-scope result, not a proof for arbitrary N.** 3 requests, 3 seats, sets of 1–2, 2 keys, 3 Faults. The first counterexamples to protocols like these appear at 2–3 participants, which the controls corroborate; but nothing here says what happens with 4 requests, a seat set of 3 (a 3-seat chain can be a different deadlock shape), or 1,000 concurrent clients. Exhibits A–F measure that scale, for the mechanisms, without exhaustiveness.
2. **The mapping is hand-audited, not trace-validated.** No tool replays a real execution against the specs or the specs against the code. The drift test (`test/formalMapping.test.ts`) proves the table still points at code that contains what the row says; it cannot detect a semantic change that leaves the anchor in place, a statement the audit missed, or a misreading by the auditor. A reader should treat the mapping as a reviewed claim.
3. **The hold flow is modelled for `pessimistic` only** (ADR-0017), and the other five mechanisms are abstractions: `unique_constraint`, `advisory` and the `pessimistic` booking path as the same "atomic claim"; `optimistic`'s version column and CAS-retry loop, `advisory`'s `hashtext` lock keys, and `serializable`'s SSI are **not modelled** — only their *deadlock* shape (F2) and the claim contract they share. Their correctness evidence is Exhibits B/C/E and the C2 chaos matrix, not this exhibit. The same goes for `retry_exhausted` and `withDeadlockRetry`.
4. **`COMMIT` is assumed durable.** `CommittedPersists` — whatever returned from `COMMIT` is still there after a crash — is an *assumption* of the model, and `CrashLoseCommitted` shows it is a load-bearing one. The chaos track's test of it, **C4 (Postgres restart under load, #51), was not run**. `pg_terminate_backend` (C1/C3) kills a backend, not the server, so it does not exercise WAL replay or fsync. **That assumption is therefore tested by neither track.**
5. **The Reaper is one atomic step per Hold.** The real sweep is one statement over every expired seat; the model reaps one Hold at a time (a superset of orderings), and has no stalled-sweep behavior. R7 — a sweep blocked behind a confirm's lock keeps its row locks on the other expired seats and stalls unrelated Hold/Confirm — is a chaos finding the model cannot reproduce by construction.
6. **One clock-free TTL.** Confirm checks `held_until` against the app's `Date.now()`; the Reaper uses the DB's `now()`; the model has a single monotonic `expired` flag. Skew cannot break the row-lock/re-check ordering, but it can make confirm accept a Hold the DB already considers expired (app clock behind) or answer 410 early (ahead). Neither track measures skew.
7. **Locking is idealized (O1).** Locks held momentarily by a losing attempt are not represented, so the model understates spurious 409s on confirm; and `Cancel`'s blocking `UPDATE`, the `ON CONFLICT` wait (O2), `seats.version`, `booked_by`, `held_until` columns beyond the deadline are not modelled.
8. **The layering assumption.** F3 and F4 treat seat claiming as one atomic step because F1's `ClaimMode = atomic` run holds; they do not re-derive it under crash. A flaw that only appears when per-seat claim interleaving *and* a crash combine would be outside both.
9. **Liveness is conditional, and the crash-layer liveness is checked at a reduced scope** (2 seats, 1 key, 1 Fault, `Cancel` off). `NoSeatHeldForever` holds only under weak fairness on the Reaper, time, and in-flight commits; the four liveness controls drop each assumption and fail.
10. **Two behaviors of the real implementation the model found** and did not hide: **RF1** — an Idempotency Key lives exactly as long as its `bookings` / `holds` row (ADR-0020), so a retry after Cancel / reap / confirm creates a *second* Booking / Hold (`CrashFindingKeyReuse`, trace 10; `CrashFindingHoldKeyReuse`, trace 11); **RF2** — a concurrent same-key book/hold retry can be answered 409 although the key's row is committed, because the key lookup happens before `BEGIN` (`CrashFindingSpuriousConflict`, trace 7). Both are Robustness findings, not Correctness violations: Exhibit H's Oracle 3 ("no key has more than one Booking *at the end of the run*") is satisfied by the stored state. They are drafted in `docs/phase6-robustness-ticket-drafts.md` (RF1 and RF2) and are neither fixed nor filed.

## Which claims each track supports

The two tracks answer to different evidence: Exhibit G enumerates every interleaving of an abstract protocol within bounds; Exhibit H samples real executions under injected Faults (505 measured runs, **zero Correctness violations**, 16 of 16 end-to-end negative controls red; C4 not run).

| Claim | Exhibit G (formal) | Exhibit H (chaos) | Neither |
|---|---|---|---|
| A seat is in at most one Booking/Hold, even with a backend crash at any step | ✔ small scope, abstract protocol (`SeatBelongsToAtMostOne`, `MutualExclusion` under crash) | ✔ measured: Oracle 1 on the real DB under backend-kill, partitions, latency, SIGKILL | beyond ~120 concurrent clients under Fault; beyond 3 seats exhaustively |
| A multi-seat Booking is all-or-nothing | ✔ `Atomicity` | ✔ Oracle 2 | — |
| `pessimistic`/`advisory` cannot deadlock; the four blocking mechanisms need ordering | ✔ A/B (`DeadlockNowait` vs `DeadlockUnsorted`) | partly: C1 `deadlock-pairs` under backend-kill (`pessimistic`) | the deadlock *fallback* (`withDeadlockRetry`) under Fault |
| Confirm never succeeds on an expired Hold; a Hold is confirmed at most once | ✔ `NoConfirmOnExpired`, `HoldConfirmedAtMostOnce` | ✔ C3 hold-expiry / hold-confirm under backend-kill; Exhibit F (load, no Fault) | cross-clock skew |
| No seat stays `held` forever | ✔ conditional on fairness (`NoSeatHeldForever`) | ✔ Oracle 4 on stored state after the Fault clears | a stalled reaper under a partition (R7 observed, not bounded) |
| A retried Idempotency Key never creates a second **live** Booking/Hold; a retry after an ambiguous commit replays | ✔ `KeyAtMostOne*`, `AmbiguousRetryNotRefused`, `CrashWitnessReplay*` | ✔ Oracle 3 re-sends every key: 1,434 unacknowledged commits across the C2 matrix resolved by replay (Bookings only) | Holds' replay under network Faults |
| **A key creates at most one Booking/Hold ever** | ✘ false — **RF1**, `CrashFindingKeyReuse` / `…HoldKeyReuse` | not observable (Oracle 3 reads stored state) | — (a documented limit, not yet decided) |
| **A concurrent same-key retry is never told 409 for a committed request** | ✘ false — **RF2**, `CrashFindingSpuriousConflict` | not observable (HTTP answers are never evidence, ADR-0022) | — |
| A returned `COMMIT` survives the database being killed | assumed (`CommittedPersists`) | not tested (C4 not run) | **both** |
| The process survives a torn connection; errors are classified; no hung locks (R1–R7) | not modelled | ✔ observed — 135 of 143 unmodified runs under a connection-tearing Fault crashed the app (R1/R2); unclassified 500s (R3); no timeouts (R4) | — (open; Robustness tickets drafted) |
| `optimistic` / `serializable` / `advisory` internals under Fault | not modelled | ✔ C2 matrix, six mechanisms | their behavior at scale under Fault |
| Throughput / latency / per-seat isolation (NFR1–NFR3) | not in scope | not in scope (Exhibit H explicitly) | Exhibits C and E |
| Clock skew between app and DB; fsync / WAL / replication; network partitions in the model | no | partitions yes (Toxiproxy), skew and restart no | skew, restart, WAL |

## Record consistency check

Every state count, depth and trace length that `formal/README.md` states (the F1 default model, F2's three modes, the F3 graph, `CrashSafety` and `CrashLiveRecovery`, and the trace lengths of the F3/F4 controls and findings) agrees with this run; the other trace lengths and every wall-clock time are new in this exhibit. Differences, none material: (a) `LifecycleLive*` is "≈10 s each" in the README and 9.2 s / 13.0 s wall here; (b) the README speaks of "~50" negative configurations; the exact count is 44 (3 + 4 + 14 + 23 across the four modules); (c) the whole `check.sh --all` took 3 min 17 s on this machine, including the first-use jar download. The un-reduced 33,000,288-state `CrashSafety` cross-check (6 min 29 s) is cited from the README and **not re-run**.

## Reproducing

```bash
npm run formal:check                                 # the nine positive checks (needs Docker; downloads and verifies the pinned jar on first use)
npm run formal:check:negative                        # the 44 controls / findings / witnesses
bash formal/check.sh --all                           # both; exit 0 only if every check behaves as expected (~3 min)
FORMAL_SHOW_TRACE=1 bash formal/check.sh --all       # also print every counterexample trace (the three above are from this)
npx vitest run test/formalMapping.test.ts            # the mapping drift test (no database)
```

## Next step

Phase 6's formal and chaos tracks are both recorded. Remaining before the umbrella (#42) can close: the Robustness findings R1–R7 and RF1–RF2 are drafted but not filed (`docs/phase6-robustness-ticket-drafts.md`); the three audit observations above (O1–O3) are candidates to add to those drafts or to dismiss; and C4 (Postgres restart) is still the one test of the durability assumption neither track covers.
