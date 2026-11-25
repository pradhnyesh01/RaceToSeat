# Phase 6 Robustness-finding fix tickets — drafts for review

**Status: drafts, not filed.** Written by C5 (issue #52) from the evidence consolidated in [Exhibit H](evidence/exhibit-h-phase6-chaos.md). Nothing here has been filed as a GitHub issue and no finding has been fixed — per ADR-0022 the chaos tickets measured unmodified code, and per #52 each Robustness finding becomes its own ticket with its own before/after rerun. When you approve a draft, file it in the same shape as #38–#52 (title, `ready-for-agent` label, the sections below), then replace the `draft Rn` references in **Blocked by** with the real issue numbers and add the issue links to Exhibit H's findings table.

Finding numbers are the **canonical** list from Exhibit H (C2 and C3 had each used "R5" for different findings): R1–R4 as in C1; **R5** = `advisory` stale-snapshot 500 (C2's R5); **R6** = retry-loop latency amplification (C2's R6); **R7** = stalled reaper blocks unrelated Hold/Confirm (C3's "R5").

**Two further drafts, RF1 and RF2, are *formal-derived*** and deliberately numbered apart from the chaos-observed R1–R7: they were found by the formal track's model checking (F4, #47, merged to `main` as 2f47207; see `formal/README.md`, "Findings: behavior the model exposes in the real implementation"), not by any chaos run, so no "before" number in them comes from `docs/evidence/chaos/`. Their before/after criteria are therefore a deterministic regression test on the real code path plus the matching `CrashFinding*` TLC configuration flipping from *violated on purpose* to *passing* — not a chaos rerun (a clean chaos run cannot see them; Exhibit H says so under "What this does not show"). They live further down, under "Formal-derived findings".

None of these is a Correctness violation: every Oracle stayed intact in every measured run (505 runs, 0 violations), and neither formal-derived finding fails a chaos Oracle. They are fixes to availability, diagnosability and latency, and none may weaken the single hard gate (zero double-booking).

| Draft | Finding | Class | Suggested order | Blocked by |
|---|---|---|---|---|
| [R1](#r1--process-survives-an-error-on-a-checked-out-connection) | Process exits on a checked-out connection error | Robustness | 1 | — |
| [R2](#r2--process-survives-an-error-on-an-idle-pooled-connection) | Process exits on an idle pooled connection error | Robustness | 1 (same seam as R1) | — (coordinate with R1) |
| [R3](#r3--infrastructure-failures-keep-their-cause-and-get-a-designed-response) | Masked `ROLLBACK` / unclassified 500 | Robustness | 2 | — (rerun needs R1 or the scaffold) |
| [R4](#r4--bound-how-long-a-request-a-transaction-and-its-row-locks-can-stall) | No timeouts; a partition stalls everything for its whole duration | Robustness | 3 | R1, R3 |
| [R7](#r7--a-stalled-reaper-sweep-must-not-block-unrelated-holds-and-confirms) | Stalled reaper blocks unrelated Hold/Confirm | Robustness | 4 | — (coordinate with R4) |
| [R5](#r5--advisory-returns-409-not-500-when-a-loser-takes-its-snapshot-before-the-winner-commits) | `advisory` stale-snapshot 500 | Robustness (latent) | 5 | — |
| [R6](#r6--decide-whether-optimistic-and-serializable-retry-loops-get-a-time-budget) | Retry loops amplify latency under a slow link | Robustness (performance) | 6 | — |
| [RF1](#rf1--decide-and-state-how-long-an-idempotency-key-lives) | **Formal-derived.** Idempotency key lifetime = row lifetime: retry after Cancel/reap creates a second Booking/Hold | Robustness (formal-derived) | 7 | — (shares `idempotency.ts` with RF2) |
| [RF2](#rf2--a-same-key-retry-must-replay-not-409-when-the-originals-key-row-is-committed) | **Formal-derived.** Same-key retry can be told 409 although the original's key row is committed | Robustness (formal-derived) | 8 | — (shares `idempotency.ts` with RF1) |

Shared rerun conventions (each ticket's "before" numbers are the committed reports named in it; the "after" runs write new JSON beside them under `docs/evidence/chaos/` with a distinct label, e.g. `--label r1-after-rep1`, so `aggregate.ts --exhibit h` picks them up and the exhibit can show before and after side by side):

- Postgres up: `docker compose up -d`. For network Faults, a Toxiproxy container as in Exhibit H's "Reproducing" section (`ghcr.io/shopify/toxiproxy:2.12.0`, API `:8475`, proxy ports 5440–5449).
- **Unmodified** and `--survive-uncaught` runs stay separate (ADR-0022). A fix ticket's "after" evidence is unmodified-code evidence; the scaffold is only used to keep observing *other* findings while an earlier one is still open.
- Every "after" rerun must leave all four Oracles (and the two Hold extensions where used) green, and the negative controls (`npx vitest run test/chaos`, plus one `--expect-violations` end-to-end control) must still go red. A fix that turns an Oracle red is a Correctness violation and blocks the ticket.

---

## R1 — process survives an error on a checked-out connection

**Title:** Process must survive a killed or torn connection that a request currently owns (R1)

### Parent

Part of #42 (Phase 6; finding R1 from C1 #44, extended by C2 #49 and C3 #50)

### What to build

Today the app process exits the moment a connection that a request has checked out from the pool errors — a `pg_terminate_backend`, a TCP reset, or a proxy tearing the connection down at partition heal. The `Client` emits `'error'` with no listener attached, Node treats that as an uncaught exception, and the process exits (observed: exit code 1, log `Unhandled 'error' event … Emitted 'error' event on Client instance`). pg-pool deliberately removes its own error listener when it hands a client out (`node_modules/pg-pool/index.js:344`, restored on release at `:385`), so **adding `pool.on("error")` alone would not fix this** — it covers only the idle-client path (R2). The fix must make a torn connection fail *that request* (which then flows through the existing error path) without ending the process, for every code path that checks a client out of the pool: the six booking strategies, `pessimisticHold`, `pessimisticConfirm`, the cancellation route, and the reaper's sweep.

The design is this ticket's to decide (candidates, none tried: a `pool.on("connect")` hook that attaches a persistent `client.on("error")` to every client, a single `acquireClient()` seam replacing the nine `pool.connect()` call sites, or both). It must not swallow errors silently: the torn connection should be logged once, and the affected request must not be able to report success.

Evidence: Exhibit H, finding R1. Unmodified runs that crashed: C1 backend-kill 4/4, C2 `partition-stall` 60/60, C2 `partition-reset` 52/60 (42/42 where the cut hit in-flight work), C3 hold flow 18/18 — all on a first torn connection.

### Acceptance criteria

- [ ] **Before/after rerun, backend-kill (C1):** `npm run chaos -- --concurrency 60 --label r1-after-rep1` (unmodified, no `--survive-uncaught`), 3 repeats. Before (committed `unmodified-kill-rep1..3`): `app.exits` length 1 in every run and 119 / 114 / 110 of 120 requests unanswered. After: `app.exits` empty in every run and the unanswered count falls to the requests that were genuinely mid-flight on a killed connection (report the numbers; they must be far below the "before").
- [ ] **Before/after rerun, partition (C2):** `partition-stall` and `partition-reset` for `pessimistic` × `deadlock-pairs` and `naive` × `hammer-seat`, 5 reps each (`--base-latency-ms 40 --partition-ms 7000`, exact flags in Exhibit H's Reproducing section), unmodified. Before: crash 5/5 (`partition-stall`) and 4/5 (`partition-reset`) in each of those two cells. After: crash 0/5 in every cell; `app.restarts` 0.
- [ ] **Before/after rerun, hold flow (C3):** `npm run chaos:holds -- --mode hold-expiry` and `-- --mode hold-confirm --concurrency 100 --attempts-per-hold 1 --kill-interval-ms 10`, unmodified. Before: crash on the first kill every time. After: no crash, and the one-shot variant's killed Confirms are still completed exactly once by the key retry (Oracle 3 extension green).
- [ ] The reaper keeps sweeping after a connection it was using is killed (C3 reaper-stall variant: `--reaper-stall-seats 3` with backend-kill): after heal every expired seat is `available` (Oracle 4 green) and the process never exited.
- [ ] All four Oracles and the two Hold extensions green in every "after" run; `npx vitest run test/chaos` still green and one `--expect-violations` end-to-end control still red.
- [ ] A regression test that fails without the fix: a request whose checked-out connection is terminated mid-transaction does not terminate the process (a Vitest test that kills the backend and asserts the process/pool keeps serving).
- [ ] Full existing test suite passes unmodified; `npm run typecheck` clean. If the design changes how `pool.ts` hands out clients, record it in an ADR.
- [ ] Exhibit H regenerated (`npm run harness:aggregate -- --exhibit h`) with the before and after runs, and the R1 row's issue link filled in.

### Blocked by

None (can start immediately)

---

## R2 — process survives an error on an idle pooled connection

**Title:** Process must survive a killed idle pooled connection (R2)

### Parent

Part of #42 (Phase 6; finding R2 from C1 #44, seen again in C2 #49)

### What to build

When a connection that is *sitting idle in the pool* is killed or torn down, the `Pool` emits `'error'` with no listener and the process exits (`Emitted 'error' event on BoundPool instance`), with no request in flight at all. This is the only path `pool.on("error")` covers; the dominant checked-out path is R1. It needs its own ticket because it is separately reachable and separately reproducible, but it shares R1's seam: if R1's design already covers idle clients, this ticket reduces to adding the idle-path evidence and test, and can be closed once its acceptance criteria are met.

On handling: an idle pooled client that errors should be removed from the pool (pg-pool already does that once it has an error handler) and logged; the next request must obtain a fresh connection transparently.

Evidence: Exhibit H, finding R2. C1 `unmodified-idle-pool-kill`: load ran clean (60 × 201, 60 × 409), then every idle pooled connection was killed in one sweep (120 backends) and the app crashed on `BoundPool` with no request in flight. In C2, 9 unmodified `partition-stall` runs died *only* via `BoundPool` (the heal found nothing but idle pooled connections to tear down).

### Acceptance criteria

- [ ] **Before/after rerun (C1):** `npm run chaos -- --fault idle-pool-kill --concurrency 60 --label r2-after`, unmodified. Before (committed `unmodified-idle-pool-kill`): `app.exits` length 1, `BoundPool` event. After: `app.exits` empty, the process still serving, and a request issued *after* the sweep succeeds on a fresh connection (the harness's post-Fault replay answers 201/409, no network errors).
- [ ] **Before/after rerun (C2):** `partition-stall` with a load short enough that the heal finds only idle connections (the 9 `BoundPool`-only cases in the committed C2 reports are the reference: list their labels in the PR). After: no crash in a 10-run repeat of the same cells.
- [ ] A regression test that fails without the fix: killing every idle pooled backend does not end the process and a subsequent request is served.
- [ ] All four Oracles green; negative controls still red; suite and typecheck green.
- [ ] Exhibit H regenerated; R2 row's issue link filled in.

### Blocked by

None (coordinate with the R1 ticket — if one change delivers both, close this one against its own criteria rather than re-implementing)

---

## R3 — infrastructure failures keep their cause and get a designed response

**Title:** Preserve the original error when `ROLLBACK` fails on a dead connection, and classify infrastructure failures (R3)

### Parent

Part of #42 (Phase 6; finding R3 from C1 #44, extended by C2 #49 and C3 #50)

### What to build

Two coupled defects on any connection failure mid-transaction:

1. **A masked error.** The catch block's `await client.query("ROLLBACK")` throws on a dead connection, replacing the error that actually failed. The same pattern is in `withTransaction` (`src/db/pool.ts:47`, `BEGIN` at `:41`), `withSerializableTransaction` (`:128`, `:134`) and `withDeadlockRetry` (`:181`, `:187`). Operators' logs name the wrong error; the real root cause (the statement that failed) is discarded. Recomputed from the app logs: the catch-block `ROLLBACK`/`BEGIN` is the top frame of the logged error in 50 of 53 C1 scaffolded 500s, 250 of 258 C3 one-shot Confirm 500s, and throughout C2's scaffolded partition runs (3,109 client-visible 500s on `partition-reset`).
2. **An unclassified 500.** The global handler (`src/app.ts:10`) turns anything unrecognised into a bare `500 Internal server error`. The API's designed outcomes are `201/409/404/503` (and `410` for Confirm); an infrastructure failure is none of them, so a client cannot tell "your request lost" from "the database is unreachable, retry".

The design is this ticket's to decide: preserve the original error (log both, or attach it as `cause`), make the `ROLLBACK` best-effort when the connection is already dead, and decide what a client should see for an infrastructure failure — including whether it is a *new* outcome or reuses `503` (ADR-0012 and ADR-0015 make `503 retry_exhausted` its own outcome, so reusing it needs justification; a new outcome probably warrants its own ADR). Whatever it decides must keep `409` and `404` meaning exactly what they mean today.

Evidence: Exhibit H, finding R3.

### Acceptance criteria

- [ ] **Before/after rerun (C1, scaffolded while R1 is open):** `npm run chaos -- --survive-uncaught --kill-fraction 0.3 --concurrency 60`, 6 reps. Before (committed `survive-kill-rep1..6`): 59 kills, 53 client-visible 500s, top frame the catch-block `ROLLBACK` in 50 of 53. After: the logged error for those requests names the *original* failure (and the `ROLLBACK` failure only as secondary), and the client-visible response is the designed infrastructure outcome, not a bare 500. If R1 has landed, rerun *without* `--survive-uncaught` instead and say so.
- [ ] **Before/after rerun (C2):** `partition-reset` for `pessimistic`, `serializable` and `naive` × `deadlock-pairs` (the paths through `withTransaction`, `withSerializableTransaction`, `withDeadlockRetry` respectively), 5 reps, scaffolded unless R1 has landed. Before: scaffolded `partition-reset` answered 3,109 unclassified 500s across the matrix. After: zero unclassified 500s attributable to a dead connection in those cells.
- [ ] **Before/after rerun (C3):** `npm run chaos:holds -- --mode hold-confirm --concurrency 100 --attempts-per-hold 1 --survive-uncaught --kill-interval-ms 10`. Before: 258 Confirms answered 500, all completed exactly once by retry. After: those failures are classified, and *the retry still completes each exactly once* (Oracle 3 extension green) — a client must be able to tell it is safe to retry with the same key.
- [ ] Unit tests for each of the three transaction helpers: a failing statement followed by a failing `ROLLBACK` surfaces the original error (assert on the message/`cause`), and a failing `ROLLBACK` never turns a designed outcome (`409`, `404`, `503 retry_exhausted`) into something else.
- [ ] `409`/`404`/`410`/`503` behaviour unchanged (existing suite passes unmodified); `npm run typecheck` clean; ADR written if a new outcome is introduced.
- [ ] All four Oracles green; negative controls still red.
- [ ] Exhibit H regenerated; R3 row's issue link filled in.

### Blocked by

None (the unmodified-code rerun is easier once R1 lands; until then use the scaffold and say so)

---

## R4 — bound how long a request, a transaction and its row locks can stall

**Title:** Add timeouts so a partitioned or stalled database cannot hold requests and row locks for the whole outage (R4)

### Parent

Part of #42 (Phase 6; finding R4 — hypothesis confirmed in C1 #44, impact measured in C2 #49)

### What to build

Nothing in the stack gives up: `src/db/pool.ts` builds `new Pool({ connectionString, max })` only, and every report records `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` and `idle_session_timeout` all `0` on the server. C2 measured the consequence: during a partition every in-flight request, its transaction and its row locks stall for the *whole* partition — longest app transaction 7.4 s under a 7 s partition and 30.1 s under a 30 s one (slowest request 30,261 ms on `pessimistic`), up to 60 sessions holding row locks at once, transactions outliving the client's own timeout in 92 of 120 `partition-stall` runs. TCP keepalive cannot rescue it: the proxy accepts the connection, and `tcp_keepalives_idle` is 7200 s anyway.

The design is this ticket's to decide, including which bounds and their values: candidates are server-side `statement_timeout` / `lock_timeout` / `idle_in_transaction_session_timeout`, a pool `connectionTimeoutMillis`, a client `query_timeout`, an application-level request deadline, and TCP keepalive on the app's sockets. Constraints the ticket must resolve explicitly:

- **`55P03` collision.** `pessimistic` and `advisory` translate `55P03` (`lock_not_available`) from `NOWAIT` into `409`. A `lock_timeout` also raises `55P03`; it must not be silently reported as a seat conflict.
- **NFR3 and the retry loops.** The optimistic CAS loop and the serializable/deadlock retry loops must not be broken by a per-statement bound (R6 is the related latency finding).
- A timed-out statement or an abandoned connection is an error on a connection → depends on R1's handling and R3's classification.

Evidence: Exhibit H, finding R4 (sections A3, C).

### Acceptance criteria

- [ ] **Before/after rerun, long partition (C2):** `npx tsx load-harness/chaos/run.ts --strategy pessimistic --load deadlock-pairs --fault partition-stall --db scratch --toxiproxy-api http://localhost:8475 --proxy-port 5440 --app-port 3200 --request-timeout-ms 60000 --base-latency-ms 40 --partition-ms 30000 --label r4-after-pessimistic`, plus the same for `advisory` and `serializable`; unmodified code. Before (committed `c2long-*`): slowest request 30,261 / 30,297 / 30,294 ms, oldest app transaction 30,076 / 30,056 / 30,092 ms, 26 / 11 / 22 row-lock holders, **bounded only by the partition**. After: slowest request and oldest transaction bounded by the new timeout (state the bound and the observed maxima), row-lock holders released within the bound *during* the partition, not at heal.
- [ ] **Before/after rerun, short partition (C2 matrix cells):** `partition-stall` × `hammer-seat`/`deadlock-pairs` × the six mechanisms, 5 reps, unmodified. Before: 92 of 120 (unmodified + scaffolded) runs flagged `transaction-outlived-client-timeout`. After: none flagged, i.e. no app transaction outlives the client's own timeout T = 5 s.
- [ ] Oracle 4 green at heal in every run and the stall observer's drain shows no leaked transactions; all four Oracles green; negative controls still red.
- [ ] **No regression under normal load:** a no-Fault `hammer-seat` run per mechanism (`npm run harness`, concurrency 100) shows zero requests hitting the new timeouts and p99 within noise of the committed Exhibit C numbers — a timeout that fires under ordinary contention is a regression.
- [ ] `55P03` handling is covered by a test showing a `lock_timeout` is not reported as a `409` seat conflict (or the ticket documents why that cannot occur).
- [ ] Defaults and env overrides documented in `config.ts` with `{ min }` validation like `HOLD_TTL_SECONDS`; ADR written for the chosen bounds.
- [ ] Exhibit H regenerated (before/after side by side); R4 row's issue link filled in.

### Blocked by

- draft R1 (a timed-out or abandoned connection errors a checked-out client — the same unhandled-`'error'` path)
- draft R3 (a timeout must surface as a classified response, not another bare 500)

---

## R7 — a stalled reaper sweep must not block unrelated Holds and Confirms

**Title:** The reaper's sweep must not hold row locks on other expired seats while it waits on one locked seat (R7; C3's "R5")

### Parent

Part of #42 (Phase 6; finding R7, found in C3 #50 — that record numbers it "R5")

### What to build

`runReaperSweep` (`src/reaper.ts:32`) is one atomic statement: a chained CTE whose first step is `UPDATE seats SET status = 'available' … WHERE status = 'held' AND held_until < now()`. If that `UPDATE` blocks on a single row-locked expired seat (a slow or leaked transaction), it keeps the row locks it has *already taken* on every other expired seat it visited before it blocked. Unrelated `POST /holds` and `POST /holds/{id}/confirm` use `FOR UPDATE NOWAIT` on those seats, fail with `55P03`, and answer `409` — even though nothing is wrong with those seats. This is a per-seat isolation hole (NFR2's spirit) in a background job. With R4 (no `lock_timeout`) a permanently leaked lock stalls the reaper indefinitely.

Measured (C3, no Fault): with 3 row-locked expired "bait" seats among 12 expired seats, **0 of 12** fresh Hold attempts won in the 3.5 s window (baseline 12 of 12) and the run answered 623 × `409` (baseline 527). C3 also verified directly that a blocked sweep left `NOWAIT` on 5 other expired seats failing with `55P03`. It heals once the lock clears: every seat ended `available`, so this is Robustness, not Correctness.

The design is this ticket's to decide. Candidates from C3 (not tried): `FOR UPDATE SKIP LOCKED` in the sweep's candidate selection so a locked seat is simply left for the next tick, a `lock_timeout` on the sweep statement, or splitting the sweep into bounded batches. It must keep the properties the current single statement has (ADR-0018, the comment at `reaper.ts:10-25`): no precomputed stale-id list that a racing Confirm could invalidate, and no half-reaped state (seat reset but `hold_seats` left behind).

Evidence: Exhibit H, finding R7.

### Acceptance criteria

- [ ] **Before/after rerun, no Fault (C3):** `npm run chaos:holds -- --mode hold-expiry --reaper-stall-seats 3 --fault none --label r7-after`. Before (committed `c3-control-reaperstall-nofault`): fresh Holds won 0 of 12; 409 × 623; baseline `c3-baseline-hold-expiry-nofault` 12 of 12, 409 × 527. After: the 9 expired seats *not* held by the bait locks are reaped and won by fresh Holds in the same window (≥ 9 of 12; report the number), and the 3 bait seats are reaped once their locks clear.
- [ ] **Before/after rerun, under Fault (C3, scaffolded while R1 is open):** `npm run chaos:holds -- --mode hold-expiry --reaper-stall-seats 3 --survive-uncaught --kill-fraction 0.3`, 4 reps. Before: 78 kills, 24 reaper sweeps killed mid-flight, all seats reaped after heal. After: unchanged guarantees (all seats `available`, zero `holds`/`hold_seats` left, Oracles 1, 4 and the Hold extensions green).
- [ ] A deterministic Vitest test that fails without the fix: hold a row lock on one expired seat, run the sweep, and assert a `NOWAIT` Hold on a *different* expired seat succeeds (extends `test/reaper.test.ts`).
- [ ] The existing reaper-vs-Confirm race tests and `test/reaper.test.ts` pass unmodified (the EvalPlanQual-safety rationale is preserved); `npm run typecheck` clean; negative controls (`c3-negctl-reaper-off`, `late-confirm`, `duplicate-confirm`) still red.
- [ ] Exhibit H regenerated; R7 row's issue link filled in; CLAUDE.md's reaper description updated if the sweep's shape changes.

### Blocked by

None (coordinate with R4: a `lock_timeout` here overlaps its design, and a leaked lock is what makes this indefinite)

---

## R5 — `advisory` returns 409, not 500, when a loser takes its snapshot before the winner commits

**Title:** `advisory`: stale-snapshot race must resolve to 409, not an unclassified 500 (R5)

### Parent

Part of #42 (Phase 6; finding R5, found in C2 #49 — "R5 (new)" in that record)

### What to build

`advisory.ts` reads status and takes the lock in one statement: `SELECT id, status, pg_try_advisory_xact_lock(hashtext(id::text)) AS acquired FROM seats WHERE id = ANY($1)`. A loser's statement can take its snapshot while the seat is still `available`; the winner then commits and releases the advisory lock; only then does the loser's `pg_try_advisory_xact_lock` run — and succeeds against a stale status. The `UNIQUE(seat_id)` constraint (ADR-0008) refuses the loser's `INSERT INTO booking_seats` with `23505` — **no double-booking, the Oracles stay green** — but unlike `naive.ts:80` and `serializable.ts:87`, `advisory.ts` does not translate that violation, so the route answers an unclassified `500` instead of `409`.

This is not Fault-dependent and rare: it appeared once in 420 matrix runs (`c2-partition-stall-advisory-hammer-seat-rep1`, `500` on the replay, `booking_seats_seat_id_key` at `advisory.ts:71`) and not in 20 dedicated no-Fault advisory reruns. It is deterministically reproducible with `load-harness/chaos/repro-advisory-snapshot-race.ts` (a `pg_sleep` widens the window). It is also a case where a mechanism leans on the backstop while its own check is racy — which ADR-0013 says openly for `serializable` but not for `advisory`.

The design is this ticket's to decide (candidates, not tried): re-check status *after* the lock is held (lock first, then read in a separate statement under READ COMMITTED), and/or translate `booking_seats_seat_id_key` `23505` to `conflict` exactly as `naive`/`serializable` do. Either way ADR-0010/0006's non-blocking acquisition and its deadlock-freedom (issue #30's sorted `seat_ids`) must be preserved, and the outcome documented (an ADR or an amendment noting whether the backstop is relied upon).

Evidence: Exhibit H, finding R5.

### Acceptance criteria

- [ ] **Before/after rerun, deterministic repro:** `npx tsx load-harness/chaos/repro-advisory-snapshot-race.ts`. Before (documented in C2): the loser's request ends in a `23505` surfaced as HTTP 500. After: the same interleaving yields `409`, and no row for the loser's booking exists.
- [ ] **Before/after rerun, load:** the C2 cell that exposed it — `npx tsx load-harness/chaos/run.ts --strategy advisory --load hammer-seat --fault partition-stall --db scratch …` (exact flags in Exhibit H), 20 reps — plus the 20-run no-Fault advisory hammer (`c2adv-*`). After: zero `500`s on the replay and all four Oracles green.
- [ ] A Vitest test that fails without the fix, reproducing the interleaving deterministically (as the repro script does) and asserting `409`.
- [ ] No double-booking regression: `advisory` hammer-seat at 1,000 concurrency × 2 repeats (Exhibit C's gate) still shows zero double-bookings; existing `test/strategies/advisory.test.ts` passes unmodified; `npm run typecheck` clean.
- [ ] Exhibit H regenerated (R5's evidence row now shows the fix); R5 row's issue link filled in.

### Blocked by

None (can start immediately)

---

## R6 — decide whether `optimistic` and `serializable` retry loops get a time budget

**Title:** Retry loops multiply latency under a slow link: bound them in time, or record the trade-off (R6)

### Parent

Part of #42 (Phase 6; finding R6, found in C2 #49)

### What to build

Both mechanisms with retry loops degrade badly when each round trip is slow, even with a link *below* the client timeout. With only 100 ms added per protocol chunk (`latency-below`, T = 5 s, so the other four mechanisms never time out and sit at p95 ≈ 0.8–1.3 s):

- `optimistic` × `hammer-seat` times out **26 of 60 clients in every run** (130 / 300 over 5 reps; p95 ≈ 5.0 s) — each CAS retry (ADR-0009) costs several round trips (initial `readSeats`, `SAVEPOINT`, CAS, `ROLLBACK TO SAVEPOINT`, a second `readSeats` — the same shape Exhibit E / #36 measured as ~2.4× `naive`'s statements), and the retries compound.
- `serializable` × `deadlock-pairs` times out 37 clients and answers **206 × `503 retry_exhausted`** (ADR-0011/0012/0013) over 5 reps.

This is a design trade-off recorded because it is where "below the timeout" is not below it, and — per #36's precedent — **the legitimate outcome of this ticket may be "document it, don't fix it"**. The ticket owns the decision. Options to weigh: a total *time* budget per request in addition to the retry-*count* cap (so a slow link yields a fast `503` instead of a client timeout), fewer round trips per retry (constrained by ADR-0009: the second `readSeats` is the correctness mechanism for telling a conflict from a concurrent cancellation), or accepting it and writing the trade-off into the mechanism comparison (Phase 8). Not a safety issue: all Oracles stayed green.

Evidence: Exhibit H, finding R6.

### Acceptance criteria

- [ ] **Decision recorded** in an ADR: fix (what budget, what happens at exhaustion) or accept (why, and where it is surfaced to readers of the mechanism comparison).
- [ ] **If fixed — before/after rerun (C2 `latency-below`):** `npx tsx load-harness/chaos/run.ts --strategy optimistic --load hammer-seat --fault latency-below --db scratch --toxiproxy-api http://localhost:8475 --proxy-port 5440 --app-port 3200 --request-timeout-ms 5000 --label r6-after-optimistic` and `--strategy serializable --load deadlock-pairs`, 5 reps each, unmodified. Before (committed): optimistic 26/60 timeouts per run (130/300); serializable 37 timeouts and 206 `503` across 5 reps. After: report timeouts and `503`s per run against the stated budget.
- [ ] **If accepted:** the same two cells re-run once (3 reps) to confirm the numbers are stable, and the trade-off is written next to Exhibit C/E's mechanism caveats; no code change.
- [ ] Either way: `retry_exhausted` semantics (ADR-0012) preserved; Exhibit C's retry-exhaustion column and `optimistic`'s NFR2 note (Exhibit E) not invalidated — rerun the Phase 2 spot-check for the two mechanisms if the loops change, and all four Oracles green with negative controls still red.
- [ ] Exhibit H regenerated; R6 row's issue link filled in.

### Blocked by

None (can start immediately)

---

# Formal-derived findings

Found by TLC in the F4 crash / ambiguous-commit / idempotent-retry model, which mirrors the real `pessimistic` code paths. Neither breaks a chaos Oracle (ADR-0022 reads stored state after the Fault clears). Editing the model is within these tickets' scope even though `formal/` was off-limits to C5: a fix that makes the real code stop exhibiting the behavior must be mirrored in `formal/CrashRecovery.tla`, `formal/check.sh` and `formal/README.md`, and the formal check is the other half of the "after" evidence. Confirm the model is still pinned to the same code (it was at 2f47207) before relying on a trace number.

## RF1 — decide and state how long an Idempotency Key lives

**Title:** Idempotency-key lifetime equals row lifetime: a retry after Cancel or reap creates a second Booking/Hold (RF1, formal-derived)

### Parent

Part of #42 (Phase 6; formal-derived finding RF1, from F4 #47 — `CrashFindingKeyReuse` trace 10, `CrashFindingHoldKeyReuse` trace 11)

### What to build

The only home of an Idempotency Key is the `idempotency_key … UNIQUE` column of the `bookings` / `holds` row. ADR-0020 deletes that row on Cancel, Confirm and reap, so the key is forgotten with it. Consequences, both reproduced by the model: **book → cancel → retry the same key creates a second Booking**, and **hold → expire → reap → retry the same key creates a second, fresh Hold**. The model's `BookingKeyCreatesAtMostOne` / `HoldKeyCreatesAtMostOne` ("a key creates at most one Booking/Hold *ever*") are therefore false for the real code; what holds is `KeyAtMostOneBooking` / `KeyAtMostOneHold` (at most one **live** row) and `KeyReuseOnlyAfterRelease`. Chaos Oracle 3's wording ("no key has more than one Booking") is satisfied by exactly this reading, so a client that replays a *stale* request after cancelling gets a new Booking, not a replay.

This is also a mismatch with the project's own glossary: `CONTEXT.md` defines **Idempotency Key** as a token whose requests "must never produce two Bookings or two Holds". The ticket must resolve that contradiction one way or the other. The design is the ticket's to decide, and **"keep today's behavior and amend the contract" is a legitimate outcome** (as with #36 and R6): candidates are (a) retain keys beyond their row — a dedicated `idempotency_keys` table (key → what it created, retention/expiry policy; note the roadmap's earlier "dedupe table" was superseded in Phase 0/1 by the UNIQUE column, RaceToSeat#1, so this reverses that choice and needs an ADR), or a tombstone on the deleted row; (b) keep key = row lifetime and rewrite the `CONTEXT.md` definition and API documentation to say "dedupes while the Booking/Hold exists". If (a), also decide what a post-Cancel retry should answer (a replay would hand back an id for a Booking that no longer exists; a distinct outcome such as `410`/`409` may be right) and how `hold-confirm:<id>` synthesized keys (`pessimisticConfirm.ts`) retire.

Evidence: Exhibit H, finding RF1 (cited from `formal/README.md`; not a chaos result).

### Acceptance criteria

- [ ] **Decision recorded in an ADR** (retain keys vs. document the contract), and `CONTEXT.md`'s **Idempotency Key** definition made consistent with it.
- [ ] **Deterministic regression tests on the real code path** (Vitest, `app.inject()` + `pool.query` like `test/strategies/*.test.ts`) that fail before the change and encode the decision: (i) `POST /bookings` → `DELETE /bookings/{id}` → `POST /bookings` with the *same* `idempotency_key`; (ii) `POST /holds` → expire (`expireHold` helper) → `runReaperSweep` → `POST /holds` with the same key. If keys are retained: neither creates a second row and the response is the decided one. If the contract is documented instead: the tests pin today's behavior so it can no longer change by accident.
- [ ] **Formal "after":** `formal/CrashRecovery.tla` updated to mirror the decision, and the matching configurations flip from *violated on purpose* to *passing* — if keys are retained, `CrashFindingKeyReuse` (`BookingKeyCreatesAtMostOne`) and `CrashFindingHoldKeyReuse` (`HoldKeyCreatesAtMostOne`) move out of `formal/check.sh`'s expected-violation list into the positive checks; if the contract is documented, they stay violated-on-purpose and `formal/README.md` records the decision next to them. Either way `npm run formal:check` and `npm run formal:check:negative` pass, and `formal/README.md`'s "Findings" section is updated.
- [ ] **Chaos non-regression:** one matrix cell per mechanism family still passes all four Oracles with the key logic changed (e.g. the C2 `latency-above` cells for `naive` and `pessimistic` × `hammer-seat`, which resolve unacknowledged commits purely by Idempotency-Key replay: Exhibit H shows 5 unacknowledged commits per cell, all resolved to exactly one Booking). If a new Oracle is added to cover post-Cancel replay, it ships with its own negative control (ADR-0023); note that HTTP statuses stay non-evidence (ADR-0022).
- [ ] Full existing suite passes (existing idempotency tests unmodified unless the decision changes them, in which case say which and why); `npm run typecheck` clean.
- [ ] Exhibit H regenerated if any chaos run is added; RF1 row's issue link filled in.

### Blocked by

None (coordinate with RF2, which edits the same `src/strategies/idempotency.ts` helpers)

---

## RF2 — a same-key retry must replay, not 409, when the original's key row is committed

**Title:** A concurrent same-key book/hold retry can be told 409 although the original's key is already committed (RF2, formal-derived)

### Parent

Part of #42 (Phase 6; formal-derived finding RF2, from F4 #47 — `CrashFindingSpuriousConflict` trace 7, invariant `KeyNeverFalselyRefused`)

### What to build

`bookSeatPessimistic` and `holdSeatsPessimistic` look the Idempotency Key up **before `BEGIN`** (`src/strategies/pessimistic.ts:25`, `src/strategies/pessimisticHold.ts:20`). If the original attempt commits *between that lookup and the retry's `SELECT … FOR UPDATE NOWAIT`*, the retry's lock succeeds, sees the seat already taken, and answers `409 conflict` — not a replay of the original. (If the original is still in flight, `NOWAIT` fails immediately: also 409, but no row is committed yet, so that case is correct.) If the original's response was also lost, the client's only answer is a 409 for a request that succeeded; only a *further* retry, which overlaps nothing, learns the truth. `resolveIdempotencyKeyRace` (unique violation → replay) does not catch it: under `pessimistic` that path is reachable only when a same-key retry wants *different* seats, because for the same seats `NOWAIT` / the status check refuses first. The Confirm path is **not** affected (`ConfirmNeverFalselyRefused` holds): `confirmHoldPessimistic` repeats its key lookup inside the transaction, after its locks, which is exactly what the book/hold paths lack.

The same pre-`BEGIN` lookup exists in `naive.ts:37` and `advisory.ts:37`; whether it yields a spurious 409 there depends on each mechanism's own conflict path and was **not modeled** (F4 models `pessimistic` only). The ticket must survey every strategy that does a pre-transaction key lookup and either fix it or record why it cannot misreport.

The design is the ticket's to decide; candidates (not tried): repeat the key lookup inside the transaction after the locks are taken (mirroring `confirmHoldPessimistic`), or, on the `conflict` path only, re-check the key once on a fresh read before answering 409 and replay if found. It must preserve ADR-0006's non-blocking acquisition and `404`-before-`409` precedence, and must not turn a genuine conflict (a *different* key wanting a taken seat) into a replay.

Evidence: Exhibit H, finding RF2 (cited from `formal/README.md`; not a chaos result — no Oracle can see it because the Booking exists exactly once and the wrong answer is an HTTP status).

### Acceptance criteria

- [ ] **Deterministic regression tests on the real code path** that fail before the fix: for `POST /bookings` under `pessimistic`, drive the interleaving explicitly (the retry's key lookup misses; the original then commits; the retry then reaches its lock) using query interception (`interceptQuery` in `test/testDb.ts`, as `test/strategies/serializableRetryExhaustion.test.ts` does), and assert the retry answers `201`/idempotent replay with the **original's booking id** — not `409`. Same test for `POST /holds` (`holdSeatsPessimistic`) answering a replay of the original Hold. Companion tests, passing before and after: a *different* key wanting the same seat still gets `409`; an in-flight original still makes the retry `409` without a replay (no row yet).
- [ ] **Formal "after":** `formal/CrashRecovery.tla` updated so the book/hold lookup mirrors the fix, and `CrashFindingSpuriousConflict` moves from *violated on purpose* (`KeyNeverFalselyRefused`) to *passing* in `formal/check.sh`; `CrashWitnessKeyRace` and the replay witnesses (`CrashWitnessReplay*`) still hold, `ConfirmNeverFalselyRefused` unchanged; `npm run formal:check` and `npm run formal:check:negative` pass; `formal/README.md`'s "Findings" section updated.
- [ ] **Survey result recorded:** for each of `naive`, `advisory` (and any other strategy found) either a fix + test, or a written reason it cannot answer a spurious 409.
- [ ] **Chaos non-regression:** the C2 `latency-above` cells (unacknowledged commits resolved by replay) for `pessimistic` × `hammer-seat` and × `deadlock-pairs`, 5 reps, unmodified: all four Oracles green and the post-Fault replay still ends with exactly one Booking per key. (This shows no regression; it cannot show the bug fixed — see above.)
- [ ] Existing suite passes unmodified (`pessimistic.test.ts`, `pessimisticHold.test.ts`, idempotency tests); `npm run typecheck` clean.
- [ ] RF2 row's issue link filled in on Exhibit H.

### Blocked by

None (coordinate with RF1, which edits the same `src/strategies/idempotency.ts` helpers)
