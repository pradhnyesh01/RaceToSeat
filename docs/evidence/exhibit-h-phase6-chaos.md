# Exhibit H — Phase 6 chaos testing: four DB-state Oracles under injected Faults

Phase 6 deliverable (todo.md, issue #52 / C5, under umbrella #42): evidence that the project's single hard guarantee — no Seat claimed twice, no torn or duplicate Booking, nothing left stuck — survives failure, not just the happy path. It consolidates the three chaos tickets that ran (C1 #44 backend-kill, C2 #49 latency/partition/app-SIGKILL, C3 #50 hold/confirm/reaper) into one document. **C4 (#51, Postgres restart under load) was not run**; it is the stretch item first in the cut order. The formal-proof half of Phase 6 is Exhibit G (F5) and is not covered here, except that the two Robustness findings the formal track's model checking exposed in the real implementation (RF1–RF2) are recorded below, separately from the chaos-observed ones.

Every number below is recomputed from the per-run JSON reports in `docs/evidence/chaos/` by `npm run harness:aggregate -- --exhibit h` (`load-harness/exhibitH.ts`). The prose findings records (`chaos-c1-tracer-findings.md`, `chaos-c2-fault-matrix.md`, `chaos-c3-holds-under-fault.md`) were *checked against* the JSON, not copied; the disagreements are listed under "Record consistency check". Definitions (Fault, Ambiguous outcome, Oracle, Correctness violation, Robustness finding) are in `CONTEXT.md`; the reasoning is ADR-0022 (what "correct under chaos" means) and ADR-0023 (negative controls without production toggles).

## Headline

|  |  |
|---|---|
| Report files read (`docs/evidence/chaos/*.json`) | **623** — 556 pre-fix (everything below except section E), 67 post-fix `r1-after-*` reruns (issue #53, section E) |
| Measured runs (every run that is not a negative control) | **540** — 516 under a Fault (332 on unmodified code, 184 with the `--survive-uncaught` scaffold), 24 no-Fault baselines/reruns |
| **Correctness violations** in measured runs (any Oracle failing) | **0** |
| Negative controls that went red as required | **16 of 16** end-to-end (`expectViolations`); the control's control on the real schema stayed green in 1 of 1 |
| Robustness findings (canonical numbering) | **7** chaos-observed (R1–R7) + **2** formal-derived (RF1–RF2, found by model checking, not by a chaos run); R1 fixed by #53 (section E); the other eight are not fixed and filed as fix tickets #54–#61 (drafts in `docs/phase6-robustness-ticket-drafts.md`) |
| Production code changed | None by the chaos tickets themselves (C1–C5: `src/` and `db/schema.sql` untouched, measure-first policy, ADR-0022). The first fix, #53, changes `src/db/pool.ts` only (ADR-0024); `db/schema.sql` is still untouched |

**Read the zero with its caveat.** The unmodified application dies on the first torn connection (R1/R2): 135 of 143 unmodified runs under a connection-tearing Fault (backend-kill, idle-pool-kill, partition-stall, partition-reset) ended with the process exiting, and in the four C1 unmodified backend-kill runs 299 of 300, 119 of 120, 114 of 120, 110 of 120 requests (respectively) got no answer. In 46 of 60 unmodified `partition-stall` runs *every* request went unanswered (the partition outlasted the client timeout). So **the unmodified runs mostly judge little**: "all four Oracles pass" is honest there, but largely because almost nothing ran before the process was gone, and the harness's restart plus full key replay then produced a clean state. The meaningful evidence that the Oracles hold *across many Faults and ongoing traffic* is the `--survive-uncaught` scaffolded runs — which are reported separately (ADR-0022) and never merged with the unmodified ones. Neither is evidence about a production deployment with a process supervisor: the harness restart is a stand-in for one.

## Method

- **App under test**: `tsx src/server.ts` unmodified, as a child process, one mechanism per process (`BOOKING_STRATEGY`, ADR-0002). Its `DATABASE_URL` points at Toxiproxy where a network Fault is injected, straight at Postgres for backend-kill. The harness's own driver/Oracle connections always go straight to Postgres, so a Fault on the app's path never blinds the checker. **No production code changed in any chaos ticket** (`src/`, `db/schema.sql` untouched) — the pre-fix evidence. Section E's after-runs are against the code with #53's fix (`src/db/pool.ts`).
- **Isolation**: C2 and C3 runs each use a throwaway database (`racetoseat_chaos_<hex>`: the real `db/schema.sql` applied verbatim, created and dropped within the run), a per-run `application_name`, per-run Toxiproxy proxy, and distinct app/proxy port ranges. The backend killer is scoped by database and `application_name`. C1's runs used the shared dev database.
- **Loads** (existing k6 scripts, unmodified except for an optional `REQUEST_TIMEOUT` env): `hammer-seat` (60 clients, one seat), `deadlock-pairs` (60 requests = 30 disjoint 2-seat pairs × both orderings in C2; 60 pairs/120 requests in C1), C3's `hold-expiry` (12 seats, every Hold already expired, then 5 Confirms + 5 fresh `POST /holds` per seat race the reaper) and `hold-confirm` (Confirms against live Holds). 60 clients keeps the load generator under macOS's 128-deep listen backlog (see Test environment).
- **Per run**: the Fault is applied; the load drains; the Fault clears; the app is restarted if it crashed (the crash stays on record); **every Idempotency Key is re-sent** (the Ambiguous-outcome recovery path); then the four Oracles run against stored state. A stall observer samples the app's backends every 50 ms (open transactions, row-lock holders, oldest age) and measures how long after the Fault clears every app transaction takes to end ("drain").
- **Repeats**: 5 reps of every C2 cell; C1 and C3 as tabulated. **Two variants, never merged (ADR-0022)**: *unmodified* code, and *scaffolded* runs where `--survive-uncaught` preloads an `uncaughtException` handler into the app so the first torn connection does not end the run. The scaffold is harness-only (nothing in `src/` changes), counts every exception it swallows, and exists solely so *later, independent* findings and the Oracles' behaviour across many kills stay observable.
- **Verdict**: HTTP responses are never evidence (a 500 can sit on a committed transaction; a 201 can describe state a kill never let persist). The verdict is the Oracles' read of stored state.

## Fault matrix

| Fault | What it does (parameters read from the reports) | Where | Runs |
|---|---|---|---|
| `backend-kill` | `pg_terminate_backend` on app backends that are inside a transaction (active mid-statement or idle-in-transaction), swept every 40 ms (10 ms for C3's one-shot Confirm runs), each eligible backend killed with probability 0.5 (0.3 for scaffolded runs). Harness connections exempt by `application_name`. | C1: `pessimistic` × `deadlock-pairs` (60 pairs). C3: hold-expiry / hold-confirm | 56 |
| `idle-pool-kill` | After the load completes, every idle pooled connection is killed in one sweep (no request in flight) | C1 only | 1 |
| `latency-below` | Toxiproxy `latency` toxic, 100 ms on every Postgres→app chunk (each protocol round trip costs +100 ms), below the 5000 ms client request timeout | C2: six mechanisms × `hammer-seat`/`deadlock-pairs`, 5 reps | 60 |
| `latency-above` | Same toxic at 800 ms/chunk: connection setup alone (~4 chunks) plus 6+ round trips per booking exceeds the 5000 ms timeout, so every request times out client-side while its transaction still commits server-side (an Ambiguous outcome). Toxic removed at load end; removal flushes buffered bytes. | C2, as above | 60 |
| `partition-stall` | Toxiproxy `timeout` toxic (timeout=0) both directions: traffic swallowed, connections stay open. Applied 20–420 ms after the first app transaction appears in Postgres, held 7000 ms (> the 5000 ms timeout), then healed. Base latency 40 ms/chunk so cuts land mid-transaction. **Toxiproxy's heal tears the stalled connections down** (it does not resume them). | C2, as above (unmodified and scaffolded) | 120 |
| `partition-reset` | Toxiproxy `reset_peer` toxic both directions: every connection RST for 7000 ms, same timing and base latency as above | C2, as above (unmodified and scaffolded) | 120 |
| `app-sigkill` | `SIGKILL` of the app's whole process tree (the `tsx` wrapper and its server child) 20–270 ms after the first app transaction, then the harness restarts it (~650 ms). One kill per run. | C2, as above | 60 |
| Postgres restart | **Not run.** C4 (#51) is the stretch item in the cut order and was not started. | — | 0 |

Toxiproxy 2.12.0 behaviours the network Faults rest on (probed by C2, not assumed): removing a `latency` toxic **flushes** buffered bytes (an in-flight query completes — a lossless slow link); removing a `timeout` toxic does **not** resume the session — the proxy tears the stalled connection down, so both ends see it close; `reset_peer` resets connections immediately. A real partition that TCP retransmits across would not sever connections at heal, so `partition-stall` here is "a partition whose heal severs the connections that lived through it", a harsher heal than a lossless one.

## Oracles

All four are SQL against stored state after the Fault has cleared (`load-harness/chaos/oracles.ts`, ADR-0022); the only HTTP-derived input is the Idempotency-Key replay, which is an *action*, not evidence. Oracle 2 needs the intended seat set per request, which only the harness's client-side ledger of intent (key → requested seats) can supply.

| # | Oracle | Fails (Correctness violation) when… |
|---|---|---|
| 1 | Mutual exclusion | a Seat is claimed by more than one Booking/Hold (or by a Booking and a Hold at once), or `seats` disagrees with the claim rows about who owns it |
| 2 | No torn state | a Booking holds fewer/other Seats than its Idempotency Key requested, or a Seat is `booked` with no Booking |
| 3 | Idempotent recovery | after the Fault clears and every key is re-sent, a key has more than one Booking, or a key's existing Booking changed under the replay (a key that lost its seat legitimately has none, so "exactly one" is *not* demanded of every key) |
| 4 | Liveness | a Seat is `held` without a Hold, `held` past expiry + grace, or still row-locked by a transaction that never ended |
| 2 ext | No Booking from an expired Hold (C3, `holdOracles.ts`) | a Booking exists under `hold-confirm:<holdId>` with `created_at >= held_until`, using the Hold's `held_until` snapshotted from the database before the Fault |
| 3 ext | A live Hold's retried Confirm yields exactly one Booking (C3) | a provably live Hold ends with zero, or more than one, Booking after Confirm was retried (the base Oracle 3 only demands "at most one") |

## Negative controls — every checker shown failing (ADR-0023)

A clean run is only evidence if the same pipeline demonstrably goes red on a run that should fail. No control touches `src/` or `db/schema.sql`, and none uses a test-only toggle in production code.

### Unit controls

| Test file | Tests | What it hand-corrupts / pins | Mutation check / note (recorded by the ticket that ran it; not re-run for this exhibit) |
|---|---|---|---|
| `test/chaos/oracles.test.ts` | 28 | each of Oracles 1–4 against a hand-corrupted scratch DB (double-booked seat, torn/extra/missing-seat Booking, duplicated/replaced/vanished key, held seat with no Hold, expired-never-reaped Hold, leaked row lock), each with a clean-state twin | C1 by hand: neutering the Oracles' verdict fails 20 of 28 (the other 8 are the clean twins) |
| `test/chaos/faults.test.ts` | 6 | backend-kill driver | C1: pins the Fault driver's contract (kills what it says, never harness connections); C2 added one `appName`-scoping test |
| `test/chaos/faultScoping.test.ts` | 1 | Fault confined to an application_name allow-list | C3: `onlyApplicationName` allow-list scoping |
| `test/chaos/c2.test.ts` | 9 | stall sampler, drain wait, app-kill driver, and (real Toxiproxy) latency / stall-partition / reset-partition behaviour | C2 by hand: neutering `startNetworkFault` and the drain wait fails 4 of 9 (4 of the 9 need a reachable Toxiproxy and are skipped without one) |
| `test/chaos/holdOracles.test.ts` | 15 | late Booking (+ boundary ±1 µs), live Hold with no/two Bookings, half-applied Reaper shapes, Confirm leaving a Hold behind — each with a clean twin | C3 by hand: neutering the two new Oracles fails 4; late-confirm predicate `false` fails 2; `>` instead of `>=` fails 1 (boundary test); neutering Oracle 4's expiry predicate fails 3; accepting any count in exactly-one fails 2 |

**59 unit controls** (counted from the test files). Their pass/fail status was recorded by C1/C2/C3 against the shared Postgres; this ticket did not re-run them (another session was using that database), so they are cited, not re-verified. Mutation checks were done once by hand by those tickets.

### End-to-end controls (computed from the reports)

**C1 — `naive` on a scratch DB without `UNIQUE(seat_id)`, no Fault, plus the control's control on the real schema**

| Run | Workload | Fault | Database | Oracles 1–4 | Outcome | What the Oracle found |
|---|---|---|---|---|---|---|
| `negctl-naive-scratch-rep1` | `naive` × `hammer-seat` | `none` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 13 bookings |
| `negctl-naive-scratch-rep2` | `naive` × `hammer-seat` | `none` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 7 bookings |
| `negctl-naive-scratch-rep3` | `naive` × `hammer-seat` | `none` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 8 bookings |
| `negctl-naive-shared-schema` | `naive` × `hammer-seat` | `none` | shared | 1✓ 2✓ 3✓ 4✓ | clean | — |

**C2 — the same scratch-DB `naive` workload under each of the five new Faults (2 reps each)**

| Run | Workload | Fault | Database | Oracles 1–4 | Outcome | What the Oracle found |
|---|---|---|---|---|---|---|
| `c2ctl-app-sigkill-naive-no-unique-rep1` | `naive` × `hammer-seat` | `app-sigkill` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 10 bookings |
| `c2ctl-app-sigkill-naive-no-unique-rep2` | `naive` × `hammer-seat` | `app-sigkill` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 10 bookings |
| `c2ctl-latency-above-naive-no-unique-rep1` | `naive` × `hammer-seat` | `latency-above` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 60 bookings |
| `c2ctl-latency-above-naive-no-unique-rep2` | `naive` × `hammer-seat` | `latency-above` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 60 bookings |
| `c2ctl-latency-below-naive-no-unique-rep1` | `naive` × `hammer-seat` | `latency-below` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 60 bookings |
| `c2ctl-latency-below-naive-no-unique-rep2` | `naive` × `hammer-seat` | `latency-below` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 60 bookings |
| `c2ctl-partition-reset-naive-no-unique-rep1` | `naive` × `hammer-seat` | `partition-reset` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 10 bookings |
| `c2ctl-partition-reset-naive-no-unique-rep2` | `naive` × `hammer-seat` | `partition-reset` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 10 bookings |
| `c2ctl-partition-stall-naive-no-unique-rep1` | `naive` × `hammer-seat` | `partition-stall` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 9 bookings |
| `c2ctl-partition-stall-naive-no-unique-rep2` | `naive` × `hammer-seat` | `partition-stall` | scratch-no-unique | 1✗ 2✓ 3✓ 4✓ | **flagged** | one seat is claimed by 10 bookings |

**C3 — hold-oracle controls**

| Run | Workload | Fault | Failing Oracles |
|---|---|---|---|
| `c3-negctl-duplicate-confirm` | hold-confirm + sabotage `duplicate-confirm` | `none` | 2:no torn state; 3:idempotent recovery; 3:idempotent recovery: a live Hold's retried Confirm yields exactly one Booking |
| `c3-negctl-late-confirm` | hold-expiry + sabotage `late-confirm` | `none` | 2:no torn state: no Booking from an expired Hold |
| `c3-negctl-reaper-off` | hold-expiry + reaper never ticks | `none` | 4:liveness |

The C3 sabotage controls corrupt the scratch database directly (a post-expiry Booking inserted; a second Booking under one confirm key with the idempotency UNIQUE dropped) or configure the reaper never to tick — the only way to make `pessimistic` itself violate a Hold guarantee would be to weaken production code, which ADR-0023 forbids. They prove the pipeline (ledger → Oracle → report → exit status), not the strategy.

**Strength caveat (C2's, still true):** in the partition/SIGKILL controls the double claim can come from the post-Fault replay (itself a 60-way race on one seat) rather than from the faulted load. These runs show the pipeline still *detects* under every Fault, not that each Fault is what produced the violation. Oracles 2–4 stayed green in every control, as they should (the corruption is a mutual-exclusion violation only).

## Results

All tables in this section are computed from the reports. A ✅ means the Oracles found no Correctness violation in that cell.

### A. Unmodified production code

> These runs record how the code **behaves as shipped**. Because of R1/R2 most of them end with the app process exiting on the first torn connection; the harness then restarts it and replays every key. Read "crash n/n" before reading "✅ n/n".

#### A1. C2 fault matrix — six mechanisms × two loads

300 runs; **Correctness violations: 0**. Cell legend: Oracle-clean runs/total · Fault landed on in-flight transactions · app process crashed (Robustness) · commits no client was told about (`unack`) · longest app transaction open (`tx`) · `LEAK` = transactions that never drained. A `landed 0/n` cell would be vacuous and says so.

##### latency-below

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤414ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤400ms |
| unique_constraint | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤521ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤562ms |
| pessimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤513ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤551ms |
| optimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤4.9s | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤1.2s |
| advisory | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤505ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤521ms |
| serializable | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤515ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤634ms |

##### latency-above

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤1.3s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤1.3s |
| unique_constraint | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤1.3s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤1.3s |
| pessimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤2.1s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤2.1s |
| optimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤2.1s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤2.2s |
| advisory | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤2.1s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤2.0s |
| serializable | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤2.0s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 74 · tx≤2.1s |

##### partition-stall

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 3/5 · crash 5/5 · unack 1 · tx≤7.1s | ✅ 5/5 · landed 5/5 · crash 5/5 · unack 49 · tx≤7.1s |
| unique_constraint | ✅ 5/5 · landed 3/5 · crash 5/5 · tx≤7.1s | ✅ 5/5 · landed 4/5 · crash 5/5 · tx≤7.2s |
| pessimistic | ✅ 5/5 · landed 4/5 · crash 5/5 · tx≤7.1s | ✅ 5/5 · landed 5/5 · crash 5/5 · unack 3 · tx≤7.2s |
| optimistic | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤7.4s | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤7.3s |
| advisory | ✅ 5/5 · landed 4/5 · crash 5/5 · unack 1 · tx≤7.1s | ✅ 5/5 · landed 3/5 · crash 5/5 · unack 59 · tx≤7.1s |
| serializable | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤7.2s | ✅ 5/5 · landed 3/5 · crash 5/5 · tx≤7.2s |

##### partition-reset

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 2/5 · crash 4/5 · unack 1 · tx≤173ms | ✅ 5/5 · landed 3/5 · crash 4/5 · tx≤176ms |
| unique_constraint | ✅ 5/5 · landed 3/5 · crash 5/5 · unack 1 · tx≤228ms | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤211ms |
| pessimistic | ✅ 5/5 · landed 2/5 · crash 3/5 · tx≤218ms | ✅ 5/5 · landed 3/5 · crash 4/5 · tx≤208ms |
| optimistic | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤236ms | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤309ms |
| advisory | ✅ 5/5 · landed 3/5 · crash 5/5 · tx≤167ms | ✅ 5/5 · landed 3/5 · crash 3/5 · unack 60 · tx≤224ms |
| serializable | ✅ 5/5 · landed 3/5 · crash 4/5 · tx≤218ms | ✅ 5/5 · landed 5/5 · crash 5/5 · unack 1 · tx≤258ms |

##### app-sigkill

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 4/5 · crash 0/5 · tx≤177ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤170ms |
| unique_constraint | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 3 · tx≤230ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤217ms |
| pessimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤169ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤153ms |
| optimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤145ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤282ms |
| advisory | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤206ms | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 60 · tx≤211ms |
| serializable | ✅ 5/5 · landed 4/5 · crash 0/5 · tx≤214ms | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 2 · tx≤268ms |

#### A2. Per-mechanism rollup (all five Faults, both loads)

| mechanism | runs | Oracle-clean | Fault landed | app crashed | client timeouts | unclassified 5xx | 503 (`retry_exhausted`) | unack. commits |
|---|---|---|---|---|---|---|---|---|
| `naive` | 50 | 50/50 | 42/50 | 18/50 | 1,189 | 0 | 0 | 206 |
| `unique_constraint` | 50 | 50/50 | 45/50 | 20/50 | 1,110 | 0 | 0 | 159 |
| `pessimistic` | 50 | 50/50 | 44/50 | 17/50 | 1,120 | 0 | 0 | 158 |
| `optimistic` | 50 | 50/50 | 50/50 | 20/50 | 1,329 | 0 | 0 | 155 |
| `advisory` | 50 | 50/50 | 42/50 | 18/50 | 885 | 0 | 0 | 335 |
| `serializable` | 50 | 50/50 | 45/50 | 19/50 | 1,235 | 0 | 206 | 82 |

`latency-above` sits behind most of the `unack` column: every request times out client-side while its transaction commits, so the Idempotency-Key replay is what resolves it, to exactly one Booking per key (Oracle 3 green in every run).

#### A3. Stall and drain per Fault (R4)

| Fault | runs | longest app tx | max row-lock holders | longest drain after Fault cleared | txns that never drained | client timeouts | unclassified 5xx |
|---|---|---|---|---|---|---|---|
| latency-below | 60 | 4.9s | 60 | 109ms | 0 | 167 | 0 |
| latency-above | 60 | 2.2s | 60 | 134ms | 0 | 3,600 | 0 |
| partition-stall | 60 | 7.4s | 60 | 110ms | 0 | 3,101 | 0 |
| partition-reset | 60 | 309ms | 60 | 3ms | 0 | 0 | 0 |
| app-sigkill | 60 | 282ms | 60 | 3ms | 0 | 0 | 0 |

#### A4. C1 — backend-kill vs `pessimistic` (`deadlock-pairs`)

| run | Fault | kills | requests | k6 outcomes (0 = no answer) | app exits | swallowed | Oracles 1–4 |
|---|---|---|---|---|---|---|---|
| `first-run-backend-kill` | backend-kill | 1 | 300 | 0:299 500:1 | 1 | 0 | 1✓ 2✓ 3✓ 4✓ |
| `unmodified-kill-rep1` | backend-kill | 18 | 120 | 0:119 201:1 | 1 | 0 | 1✓ 2✓ 3✓ 4✓ |
| `unmodified-kill-rep2` | backend-kill | 2 | 120 | 0:114 201:6 | 1 | 0 | 1✓ 2✓ 3✓ 4✓ |
| `unmodified-kill-rep3` | backend-kill | 5 | 120 | 0:110 201:10 | 1 | 0 | 1✓ 2✓ 3✓ 4✓ |
| `unmodified-idle-pool-kill` | idle-pool-kill | 120 | 120 | 201:60 409:60 | 1 | 0 | 1✓ 2✓ 3✓ 4✓ |

#### A5. C3 — hold → confirm → reaper under backend-kill (`pessimistic`)

| group | runs | kills | k6 outcomes (sum) | app exits | swallowed | reaper sweeps killed | Confirms completed only by retry | Oracles 1–4 + 2 ext. clean |
|---|---|---|---|---|---|---|---|---|
| hold-expiry (confirms + fresh Holds race the reaper) | 6 | 48 | 0:600 409:284 410:76 | 6 | 0 | 0 | 0 | 6/6 |
| hold-expiry + reaper stalled on 3 locked expired seats | 3 | 15 | 0:346 409:15 410:12 500:1 | 3 | 0 | 7 | 0 | 3/3 |
| hold-confirm, 3 concurrent attempts per Hold | 9 | 51 | 0:874 201:181 409:24 500:1 | 9 | 0 | 0 | 170 | 9/9 |

### B. With the `--survive-uncaught` scaffold (reported separately, never merged with A)

> Here the process survives, requests continue through the Fault, and the Oracles see real work. The swallowed exceptions are exactly the crashes A shows.

#### B1. C2 — the two partition Faults, six mechanisms × two loads

120 runs; **Correctness violations: 0**. The other three Faults were not run scaffolded: latency and app-SIGKILL never crashed the unmodified app, so they need no twin. Cell legend: Oracle-clean runs/total · Fault landed on in-flight transactions · app process crashed (Robustness) · commits no client was told about (`unack`) · longest app transaction open (`tx`) · `LEAK` = transactions that never drained. A `landed 0/n` cell would be vacuous and says so.

##### partition-stall

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 3/5 · crash 0/5 · tx≤7.1s | ✅ 5/5 · landed 3/5 · crash 0/5 · tx≤7.1s |
| unique_constraint | ✅ 5/5 · landed 3/5 · crash 0/5 · tx≤7.2s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 89 · tx≤7.2s |
| pessimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤7.1s | ✅ 5/5 · landed 2/5 · crash 0/5 · tx≤7.1s |
| optimistic | ✅ 5/5 · landed 4/5 · crash 0/5 · tx≤7.3s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 30 · tx≤7.4s |
| advisory | ✅ 5/5 · landed 4/5 · crash 0/5 · tx≤7.1s | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 59 · tx≤7.1s |
| serializable | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 1 · tx≤7.1s | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 1 · tx≤7.2s |

##### partition-reset

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 2/5 · crash 0/5 · tx≤173ms | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 87 · tx≤167ms |
| unique_constraint | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 2 · tx≤1.9s | ✅ 5/5 · landed 2/5 · crash 0/5 · tx≤203ms |
| pessimistic | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 1 · tx≤215ms | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 40 · tx≤209ms |
| optimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤2.8s | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤309ms |
| advisory | ✅ 5/5 · landed 3/5 · crash 0/5 · tx≤225ms | ✅ 5/5 · landed 3/5 · crash 0/5 · unack 29 · tx≤220ms |
| serializable | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤793ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤278ms |

#### B2. Per-mechanism rollup

| mechanism | runs | Oracle-clean | Fault landed | app crashed | client timeouts | unclassified 5xx | 503 (`retry_exhausted`) | unack. commits |
|---|---|---|---|---|---|---|---|---|
| `naive` | 20 | 20/20 | 13/20 | 0/20 | 330 | 536 | 0 | 87 |
| `unique_constraint` | 20 | 20/20 | 14/20 | 0/20 | 539 | 539 | 0 | 91 |
| `pessimistic` | 20 | 20/20 | 16/20 | 0/20 | 510 | 539 | 0 | 41 |
| `optimistic` | 20 | 20/20 | 19/20 | 0/20 | 599 | 599 | 0 | 30 |
| `advisory` | 20 | 20/20 | 14/20 | 0/20 | 301 | 299 | 0 | 88 |
| `serializable` | 20 | 20/20 | 18/20 | 0/20 | 593 | 597 | 0 | 2 |

#### B3. Stall and drain per Fault

| Fault | runs | longest app tx | max row-lock holders | longest drain after Fault cleared | txns that never drained | client timeouts | unclassified 5xx |
|---|---|---|---|---|---|---|---|
| partition-stall | 60 | 7.4s | 60 | 109ms | 0 | 2,872 | 0 |
| partition-reset | 60 | 2.8s | 60 | 4ms | 0 | 0 | 3,109 |

#### B4. C1 — scaffolded backend-kill vs `pessimistic`

| run | Fault | kills | requests | k6 outcomes (0 = no answer) | app exits | swallowed | Oracles 1–4 |
|---|---|---|---|---|---|---|---|
| `survive-kill-rep1` | backend-kill | 14 | 120 | 201:59 409:50 500:11 | 0 | 0 | 1✓ 2✓ 3✓ 4✓ |
| `survive-kill-rep2` | backend-kill | 9 | 120 | 201:59 409:52 500:9 | 0 | 0 | 1✓ 2✓ 3✓ 4✓ |
| `survive-kill-rep3` | backend-kill | 11 | 120 | 201:59 409:52 500:9 | 0 | 0 | 1✓ 2✓ 3✓ 4✓ |
| `survive-kill-rep4` | backend-kill | 9 | 120 | 201:57 409:54 500:9 | 0 | 0 | 1✓ 2✓ 3✓ 4✓ |
| `survive-kill-rep5` | backend-kill | 2 | 120 | 201:60 409:58 500:2 | 0 | 0 | 1✓ 2✓ 3✓ 4✓ |
| `survive-kill-rep6` | backend-kill | 14 | 120 | 201:56 409:51 500:13 | 0 | 0 | 1✓ 2✓ 3✓ 4✓ |

#### B5. C3 — scaffolded hold flow

| group | runs | kills | k6 outcomes (sum) | app exits | swallowed | reaper sweeps killed | Confirms completed only by retry | Oracles 1–4 + 2 ext. clean |
|---|---|---|---|---|---|---|---|---|
| hold-expiry (confirms + fresh Holds race the reaper) | 7 | 93 | 201:84 409:3,282 410:254 500:87 | 0 | 93 | 0 | 0 | 7/7 |
| hold-expiry + reaper stalled on 3 locked expired seats | 4 | 78 | 409:2,195 410:171 500:56 | 0 | 51 | 24 | 0 | 4/4 |
| hold-confirm, 3 concurrent attempts per Hold | 9 | 39 | 201:888 409:155 500:37 | 0 | 39 | 0 | 0 | 9/9 |
| hold-confirm, one-shot (1 attempt per Hold, kill every 10 ms) | 8 | 274 | 201:542 500:258 | 0 | 274 | 0 | 258 | 8/8 |

### C. Long partition (R4 measured directly; 30 s partition, 60 s client timeout so the client does not give up first)

| mechanism | variant | partition | client timeout | slowest request | oldest app transaction | row-lock holders | outcome at heal | drained after heal | Oracles |
|---|---|---|---|---|---|---|---|---|---|
| `advisory` | unmodified | 30.0s | 60.0s | 30,297 ms | 30,056 ms | 11 | 60×no answer; app crashed (R1) | 1 ms | 1✓ 2✓ 3✓ 4✓ |
| `pessimistic` | unmodified | 30.0s | 60.0s | 30,261 ms | 30,076 ms | 26 | 60×no answer; app crashed (R1) | 2 ms | 1✓ 2✓ 3✓ 4✓ |
| `serializable` | unmodified | 30.0s | 60.0s | 30,294 ms | 30,092 ms | 22 | 60×no answer; app crashed (R1) | 12 ms | 1✓ 2✓ 3✓ 4✓ |
| `pessimistic` | scaffolded | 30.0s | 60.0s | 30,325 ms | 30,113 ms | 30 | 60×500 | 3 ms | 1✓ 2✓ 3✓ 4✓ |

A request and its row locks stall for as long as the partition lasts; nothing gives up on its own. The flip side, measured in all 420 matrix runs: once the Fault clears, every transaction drained (longest 134 ms, 0 leaks), because the heal tears the connections down and Postgres rolls the transactions back.

### D. No-Fault baselines (hold flow) and reruns

| run | workload | k6 outcomes | app exits | Oracles clean |
|---|---|---|---|---|
| `c3-baseline-hold-confirm-nofault` | hold-confirm, no Fault | 201:84 409:36 | 0 | yes |
| `c3-baseline-hold-expiry-nofault` | hold-expiry, no Fault | 201:12 409:527 410:49 | 0 | yes |
| `c3-control-reaperstall-nofault` | hold-expiry + 3 locked expired seats (reaper stalled), no Fault | 409:623 410:37 | 0 | yes |

The 20 dedicated no-Fault advisory reruns (`c2adv-*`, R5) and the no-Fault `naive` control twin are summarised under R5 and in the controls table.

### E. After the R1 fix (#53): the same Faults against the fixed code

Issue #53 (R1) added one hook to `src/db/pool.ts` (ADR-0024: a persistent per-connection `client.on("error")` attached from `pool.on("connect")`, which covers every checkout path including `pool.query` and the reaper, plus a no-op `pool.on("error")` for the idle path). The runs below are the issue's own before/after reruns of the *unmodified* app (no `--survive-uncaught`), labelled `r1-after-*` and kept in their own group so nothing in A–D or the findings table below mixes them in. **67 after-runs: the app exited in 0 of them; Correctness violations: 0.**

**E1. C1 backend-kill** (`pessimistic` × `deadlock-pairs`, 60 pairs = 120 requests, `--concurrency 60`).

| code | runs | runs where the app exited | requests with no answer (sum) | no answer per run | HTTP 500s | backends killed | Oracles clean |
|---|---|---|---|---|---|---|---|
| before: `unmodified-kill-rep1..3` | 3 | 3 | 343 of 360 | 119 / 114 / 110 | 0 | 25 | 3/3 |
| **after**: `r1-after-rep1..6` | 6 | 0 | 0 of 720 | 0 / 0 / 0 / 0 / 0 / 0 | 103 | 119 | 6/6 |

Before the fix the first killed connection ended the process and ~everything behind it went unanswered; after it, every request is answered (a request cut mid-transaction gets an HTTP 500 — R3, not fixed here — and its Idempotency Key is replayed by the harness afterwards, as before). The 500s are the requests that were mid-flight on a killed connection (103 of them against 119 backends killed, since a kill that lands between statements or on an idle-in-transaction client may fail no request).

**E2. C2 partition** (`--base-latency-ms 40 --partition-ms 7000`, client timeout 5 s, 5 reps per cell; the "landed" column is C2's definition: app transactions were open when the Fault was applied).

| Fault | cell (5 reps each) | crashed before | crashed **after** | Fault landed on in-flight tx (before → after) | HTTP 500s (before → after) | Oracles clean after |
|---|---|---|---|---|---|---|
| `partition-stall` | `pessimistic` × `deadlock-pairs` | 5/5 | **0/5** | 5/5 → 2/5 | 0 → 0 | 5/5 |
| `partition-stall` | `naive` × `hammer-seat` | 5/5 | **0/5** | 3/5 → 5/5 | 0 → 0 | 5/5 |
| `partition-stall` | `pessimistic` × `hammer-seat` | 5/5 | **0/5** | 4/5 → 3/5 | 0 → 0 | 5/5 |
| `partition-stall` | `naive` × `deadlock-pairs` | 5/5 | **0/5** | 5/5 → 4/5 | 0 → 0 | 5/5 |
| `partition-reset` | `pessimistic` × `deadlock-pairs` | 4/5 | **0/5** | 3/5 → 2/5 | 0 → 150 | 5/5 |
| `partition-reset` | `naive` × `hammer-seat` | 4/5 | **0/5** | 2/5 → 4/5 | 0 → 300 | 5/5 |
| `partition-reset` | `pessimistic` × `hammer-seat` | 3/5 | **0/5** | 2/5 → 3/5 | 0 → 295 | 5/5 |
| `partition-reset` | `naive` × `deadlock-pairs` | 4/5 | **0/5** | 3/5 → 2/5 | 0 → 120 | 5/5 |

14 of 20 after-run `partition-stall` runs still left *every* request unanswered: that is R4 (no timeouts — the partition outlasts the 5 s client timeout), which R1's fix does not touch and which is not an improvement. What changed is that the process survives the heal (0 exits, 0 restarts) instead of crashing when the stalled connections are torn down.

**E3. C3 hold flow** (backend-kill on `pessimistic`; the one-shot row is `--concurrency 100 --attempts-per-hold 1 --kill-interval-ms 10`, no committed pre-fix run used these exact flags, so it has no "before" row; the earlier hold-confirm rows crashed on the first kill the same way).

| group | runs | kills | k6 outcomes (sum) | app exits | swallowed | reaper sweeps killed | Confirms completed only by retry | Oracles 1–4 + 2 ext. clean |
|---|---|---|---|---|---|---|---|---|
| before: hold-expiry (confirms + fresh Holds race the reaper) | 6 | 48 | 0:600 409:284 410:76 | 6 | 0 | 0 | 0 | 6/6 |
| before: hold-expiry + reaper stalled on 3 locked expired seats | 3 | 15 | 0:346 409:15 410:12 500:1 | 3 | 0 | 7 | 0 | 3/3 |
| before: hold-confirm, 3 concurrent attempts per Hold | 9 | 51 | 0:874 201:181 409:24 500:1 | 9 | 0 | 0 | 170 | 9/9 |
| **after**: hold-expiry (confirms + fresh Holds race the reaper) | 5 | 125 | 201:60 409:2,020 410:166 500:114 | 0 | 0 | 0 | 0 | 5/5 |
| **after**: hold-expiry + reaper stalled on 3 locked expired seats | 3 | 66 | 409:1,581 410:123 500:46 | 0 | 0 | 18 | 0 | 3/3 |
| **after**: hold-confirm, 3 concurrent attempts per Hold | 8 | 46 | 201:834 409:83 500:43 | 0 | 0 | 0 | 0 | 8/8 |
| **after**: hold-confirm, one-shot (1 attempt per Hold, kill every 10 ms) | 5 | 228 | 201:302 500:198 | 0 | 0 | 0 | 198 | 5/5 |

In the one-shot rows every Confirm that a kill cut was completed exactly once by the key retry (Oracle 3 extension, "a live Hold's retried Confirm yields exactly one Booking"). In the reaper-stall rows (`--reaper-stall-seats 3` + backend-kill) the reaper kept sweeping after connections it was using were killed ("reaper sweeps killed" counts its logged, survived failures) and after heal 3 of 3 runs had every expired seat `available` (Oracle 4).

**What did not improve** (measured, not hidden): the HTTP 500 count went *up* — requests that used to vanish with the process now fail individually with an unclassified 500 (R3); `partition-stall` still stalls every request for the whole partition (R4); a stalled reaper still blocks Holds/Confirms on its locked seats (R7); and `partition-reset` "landed" counts are partial, as before. During development, a first C1 attempt that carried only the per-checkout listener (no `pool.on("error")`; not kept as a report) still crashed once in 3 runs, through the idle path: a kill sweep aimed at in-transaction backends lands on a client the request has just released, which is R2's route — so R2's idle-path guard ships in the same change, and ticket #54 keeps its own acceptance criteria (idle-pool-kill rerun, partition-stall heal-only cases, regression test).

### F. After the R3 fix (#55) — masked errors and the unclassified 500

Same load, Fault and scaffold as the "before" reports (`--survive-uncaught`: the scaffolded rows were run before R1 (#53) had merged; the unmodified C1 row was run after it); the "after" runs differ in code (ADR-0025) and, necessarily, in the random timing of each kill or partition, so counts are comparable in kind, not run for run. The C1 and C3 "after" reruns used a throwaway scratch database rather than the shared one.

| Cell |  | Runs | HTTP 500 | HTTP 502 | HTTP 201 | HTTP 409 | Oracles clean |
|---|---|---|---|---|---|---|---|
| C1 backend-kill (`pessimistic`, `deadlock-pairs`, kill fraction 0.3), scaffolded | before | 6 | 53 | 0 | 350 | 317 | 6/6 |
|  | **after (#55)** | 6 | 0 | 84 | 340 | 296 | 6/6 |
| C1 backend-kill, **unmodified** (no `--survive-uncaught`; R1 merged; the before-runs mostly got no HTTP answer at all because the process exited on the first kill) | before | 4 | 1 | 0 | 17 | 0 | 4/4 |
|  | **after (#55)** | 6 | 0 | 72 | 331 | 317 | 6/6 |
| C2 `partition-reset` (`pessimistic` × `deadlock-pairs`) | before | 5 | 300 | 0 | 0 | 0 | 5/5 |
|  | **after (#55)** | 5 | 0 | 243 | 44 | 13 | 5/5 |
| C2 `partition-reset` (`serializable` × `deadlock-pairs`) | before | 5 | 297 | 0 | 3 | 0 | 5/5 |
|  | **after (#55)** | 5 | 0 | 296 | 2 | 2 | 5/5 |
| C2 `partition-reset` (`naive` × `deadlock-pairs`) | before | 5 | 297 | 0 | 3 | 0 | 5/5 |
|  | **after (#55)** | 5 | 0 | 229 | 38 | 33 | 5/5 |
| C3 hold-confirm, one-shot (`pessimistic`, backend-kill every 10 ms) | before | 8 | 258 | 0 | 542 | 0 | 8/8 |
|  | **after (#55)** | 8 | 0 | 251 | 549 | 0 | 8/8 |

**Retry still completes every Confirm exactly once.** After the Fault, the replay re-sent each hold's Confirm: 800 of 800 holds answered `201` before the fix, 800 of 800 after, and the `Oracle 3 (idempotent recovery: a live Hold's retried Confirm yields exactly one Booking)` extension passed in 8/8 reruns. A `502` is exactly the signal that this retry is safe.

**What the logged error names (hand-counted from the app logs, which are git-ignored — not derivable from the JSON).** Run like for like on a throwaway checkout of unmodified `main` (C1 command, 6 reps, same scratch database and ports as the "after" reps) and on this change, counting the first `src/` frame of every error the global handler logged:

| C1 backend-kill, 6 reps | before (unmodified `main`) | after (#55) |
|---|---|---|
| requests answered by the handler (= the 500s / 502s above, from the reports) | 67 × 500 | 84 × 502 |
| top `src/` frame is the catch-block `ROLLBACK` / `BEGIN` (`pool.ts:47`, `:41`) | **66** of 67 (64 + 2) | **0** of 84 |
| top `src/` frame is the statement that failed (`pessimistic.ts`, `idempotency.ts`) | 1 | 71 |
| top `src/` frame is the `COMMIT` that failed (`pool.ts:220`, outcome unknown) | 0 | 13 |
| logged headline is the kill itself ("terminating connection due to administrator command") | 1 | 18 |
| "ROLLBACK also failed" secondary lines | 0 | 81 |

On the three C2 `partition-reset` cells the same count over the 15 after-runs: 768 logged errors (= the 768 × 502), none whose top frame is a catch-block `ROLLBACK` (strategy statements, the failed `COMMIT`, and — for `serializable` — 48 retry `BEGIN`s on a connection that had died after a genuine `40001`; the `40001` is named on the secondary "ROLLBACK also failed" line next to it, and the request is answered 502, not 503, because no retry budget was spent) plus 2 designed `409`s whose closing `ROLLBACK` failed and which were still answered `409`.

## Robustness findings — canonical numbering (R1–R7)

C2 and C3 each independently labelled a different finding "R5". This exhibit uses one list; the three earlier records are left as written, with a short pointer note at the top of each mapping their numbers to these. **C2's R5 (advisory) and R6 keep their numbers; C3's R5 (stalled reaper) becomes R7.** None of the seven is a Correctness violation (all four Oracles stayed intact); R1 has since been fixed (#53, section E) and the other six are not, per the measure-first policy; each is filed as its own fix ticket: R1 #53, R2 #54, R3 #55, R4 #56, R5 #58, R6 #59, R7 #57 (drafts in `docs/phase6-robustness-ticket-drafts.md`).

|  | Finding | Class | Earlier numbering | Evidence recomputed from the reports |
|---|---|---|---|---|
| [R1](https://github.com/pradhnyesh01/RaceToSeat/issues/53) (fixed) | App process exits when a checked-out connection errors (unhandled `Client` `'error'`) | Robustness | C1 R1 · C2 R1 · C3 R1 | **Fixed by #53 (ADR-0024; section E): 0/67 unmodified runs crashed afterwards.** Before the fix: 134/142 unmodified runs under a connection-tearing Fault crashed (the idle-pool run is under R2; C1 backend-kill (`pessimistic`, `deadlock-pairs`): 4/4; C2 `partition-stall` (six mechanisms): 60/60; C2 `partition-reset` (six mechanisms): 52/60; C3 backend-kill on the hold flow (`pessimistic`): 18/18); 125 died on an unhandled `Client` event. `pool.on("error")` alone would not fix it: pg-pool removes its listener on checkout (`pg-pool/index.js:344`; C1 read the source) — the fix is a per-connection `client.on("error")` attached from `pool.on("connect")`, plus a `pool.on("error")` for the idle path |
| R2 | App process exits when an idle pooled connection errors (unhandled `BoundPool` `'error'`) | Robustness | C1 R2 · C2 R2 (C3: not re-tested) | Idle-pool kill, no request in flight: 1/1 crashed on `BoundPool`. 9 `partition-stall` runs died *only* via `BoundPool` (the heal found nothing but idle pooled connections). C3 did not re-test |
| R3 | `ROLLBACK` on a dead connection masks the original error; infrastructure failure surfaces as an unclassified HTTP 500 | Robustness | C1 R3 · C2 R3 · C3 R3 | On scaffolded runs 3,600 requests were answered an unclassified HTTP 500 to clients, and the app logged 6,449 dead-connection errors — more than clients saw, because 2,872 of them were logged during scaffolded `partition-stall` runs, where clients had already timed out and saw 0 5xx. The top frame of the logged error is the catch-block `ROLLBACK`/`BEGIN` on the dead client (`pool.ts:47`/`:134`/`:181`/`:187`/`:41`) — **not derivable from the JSON** (see Record consistency check). **Fix ticket [#55](https://github.com/pradhnyesh01/RaceToSeat/issues/55)** (ADR-0025): across 35 scaffolded reruns of the cells below, client-visible unclassified 500s fell from 1,206 (the same cells' committed before-runs) to 0, and 1,175 requests were answered the designed `502` instead (section E) |
| R4 | No timeouts anywhere: a partition stalls requests, transactions and row locks for its whole duration | Robustness | C1 R4 (impact pending) · C2 R4 (impact measured) · C3 R4 | 92/120 partition-stall runs flagged a transaction outliving the client timeout; longest app transaction 7.4s under a 7 s partition and 30.1s under a 30 s one; 0 transactions leaked after heal in the 420-run matrix (longest drain 134 ms). Server settings in every report: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `idle_session_timeout` all 0 |
| R5 | `advisory`: stale-snapshot race returns an unclassified HTTP 500 instead of 409 (UNIQUE backstop holds) | Robustness (latent) | C2 R5 (unchanged) | 1 of 420 matrix runs logged the `booking_seats_seat_id_key` violation behind an HTTP 500 (`c2-partition-stall-advisory-hammer-seat-rep1`); 0 of 20 dedicated no-Fault advisory reruns answered a 500. Deterministic repro: `load-harness/chaos/repro-advisory-snapshot-race.ts` (a `pg_sleep` widens the window; not re-run here). Oracles stayed green: the UNIQUE backstop held |
| R6 | Retry loops amplify latency under a slow link (`optimistic`, `serializable`) | Robustness (performance) | C2 R6 (unchanged) | At 100 ms/chunk (below the 5 s timeout) `optimistic` × `hammer-seat` timed out 130/300; `serializable` × `deadlock-pairs` timed out 37/300 and answered 206× 503; every other cell: 0 timeouts |
| R7 | A stalled reaper sweep holds row locks on other expired seats and blocks unrelated Hold/Confirm | Robustness | **C3 R5 → R7** (renumbered; C2's R5 kept the number) | Reaper stalled on 3 row-locked expired seats, no Fault: 0 of 12 fresh Hold attempts won (baseline 12 of 12), 623×409 (baseline 527). Under backend-kill 31 reaper sweeps were killed mid-flight (7 unmodified, 24 scaffolded); all seats were reaped after heal. The "blocked sweep leaves NOWAIT on 5 other expired seats failing with 55P03" probe was verified directly by C3, not recorded in a report |

Notes: **R1/R2** — a per-checkout `client.on('error')` is needed; `pool.on('error')` covers R2 only. #53's fix ships both (one hook in `src/db/pool.ts`), so R2's idle path is guarded too, though #54's own before/after criteria are still open. **R3** also affects `withSerializableTransaction` (`pool.ts:134`) and `withDeadlockRetry` (`pool.ts:181`, `:187`), not just `withTransaction` (`pool.ts:47`); the unclassified 500 is the global error handler (`src/app.ts:10`). **R5** is not Fault-dependent and rare; Oracle 1 is a statement about stored state and the `UNIQUE(seat_id)` constraint (ADR-0008) kept it correct — what failed was the HTTP answer. It is, though, a mechanism leaning on its backstop while its own check is racy, which ADR-0013 says openly about `serializable` and not yet about `advisory`. **R6** is a design trade-off of ADR-0009/0011/0013 recorded because it is where "below the timeout" is not below it. **R7** needs a leaked or slow lock (R4) to persist indefinitely.

### Formal-derived findings (RF1–RF2) — kept apart from R1–R7

The formal track's crash / ambiguous-commit / idempotent-retry model (F4, #47, merged to `main` as 2f47207) exposed two behaviours of the *real* implementation that no chaos run observed. They are numbered **RF1–RF2** so they cannot be mistaken for chaos evidence: nothing in this table is computed from `docs/evidence/chaos/*.json`; the evidence is a TLC counterexample, documented in `formal/README.md` ("Findings: behavior the model exposes in the real implementation") and cited here. They are Robustness-class: neither fails a chaos Oracle, neither is a Correctness violation, and the "violated on purpose" configs in `formal/check.sh` pin them. Not fixed; filed as RF1 #60 and RF2 #61 (drafts in `docs/phase6-robustness-ticket-drafts.md`). The formal exhibit (G, F5) will present the model side; this exhibit only records that the two findings exist and why the chaos track could not have found them.

|  | Finding | Class | Evidence (TLC counterexample; cited from `formal/README.md`, not recomputed) | Why no chaos run could see it |
|---|---|---|---|---|
| RF1 | Idempotency-key lifetime equals row lifetime: the key is forgotten when its Booking/Hold row is deleted, so a retry after Cancel / reap creates a *second* Booking / Hold | Robustness (formal-derived) | The key's only home is `bookings.idempotency_key` / `holds.idempotency_key` (`UNIQUE`), and ADR-0020 deletes that row on Cancel, Confirm and reap. So book → cancel → retry with the same key creates a second Booking, and hold → expire → reap → retry the same key creates a second, fresh Hold. TLC: `CrashFindingKeyReuse` (`BookingKeyCreatesAtMostOne` violated, trace 10) and `CrashFindingHoldKeyReuse` (`HoldKeyCreatesAtMostOne` violated, trace 11) — invariants violated on purpose in `formal/check.sh`. What *does* hold: `KeyAtMostOneBooking` / `KeyAtMostOneHold` (at most one **live** row per key) and `KeyReuseOnlyAfterRelease` | Oracle 3 demands "no key has more than one Booking" *at the end of the run*, and the stored-state reading is satisfied: after Cancel there is one row, not two. Nothing in the chaos runs cancels a Booking and then replays its key |
| RF2 | A concurrent same-key book/hold retry can be answered 409 although the original's key row is already committed (key lookup happens before `BEGIN`) | Robustness (formal-derived) | `bookSeatPessimistic` / `holdSeatsPessimistic` look the key up *before* `BEGIN` (`pessimistic.ts:25`, `pessimisticHold.ts:20`). If the original commits between that lookup and the retry's `FOR UPDATE NOWAIT`, the retry's lock succeeds, sees the seat taken and answers 409 `conflict` instead of replaying; `resolveIdempotencyKeyRace` does not catch it (it fires on a unique violation, reachable under `pessimistic` only for a same-key retry wanting *different* seats). If the original's ack was also lost, the client's only answer is a 409 for a request that succeeded; a *further* retry replays correctly. TLC: `CrashFindingSpuriousConflict` (`KeyNeverFalselyRefused` violated, trace 7). The confirm path is **not** affected (`ConfirmNeverFalselyRefused` holds): `confirmHoldPessimistic` repeats its key lookup inside the transaction. The same pre-`BEGIN` lookup also appears in `naive.ts:37` and `advisory.ts:37`; whether it yields a spurious 409 there depends on each mechanism's conflict path and was **not modeled** (F4 models `pessimistic` only) | the Oracles read stored state after the Fault clears; the Booking *exists*, exactly once, so Oracles 1–3 pass. The wrong answer is an HTTP status the client saw, which ADR-0022 deliberately never treats as evidence, and the chaos loads do not issue a same-key retry that overlaps the original's commit |

## Record consistency check

41 numbers quoted by the three findings records were re-derived from the JSON: **40 match, 1 differ**.

| Record | Claim | Record says | Recomputed |  |
|---|---|---|---|---|
| C1 | unmodified backend-kill runs where the app crashed | 4/4 | 4/4 | ✓ |
| C1 | scaffolded runs | 6 | 6 | ✓ |
| C1 | mid-transaction kills across the scaffolded runs | 59 | 59 | ✓ |
| C1 | HTTP 500s across the scaffolded runs | 53 | 53 | ✓ |
| C1 | requests unanswered in unmodified reruns 1-3 (of 120) | 119/114/110 | 119/114/110 | ✓ |
| C1 | winners Oracle 1 found on one seat, negative-control reps 1-3 | 13/7/8 | 13/7/8 | ✓ |
| C1 | negative-control runs flagged by Oracle 1 | 3/3 | 3/3 | ✓ |
| C2 | matrix runs (unmodified + scaffolded) | 420 (300+120) | 420 (300+120) | ✓ |
| C2 | Correctness violations in the matrix | 0 | 0 | ✓ |
| C2 | end-to-end controls flagged by Oracle 1 | 10/10 | 10/10 | ✓ |
| C2 | latency-above: requests that timed out client-side | 3600/3600 | 3600/3600 | ✓ |
| C2 | Bookings committed that no client was told about (matrix) | 1434 | 1434 | ✓ |
| C2 | …of which latency-above | 854 | 854 | ✓ |
| C2 | partition-stall unmodified runs that crashed | 60/60 | 60/60 | ✓ |
| C2 | …crashes via Client / BoundPool event | 51/9 | 51/9 | ✓ |
| C2 | partition-reset unmodified runs that crashed | 52/60 | 52/60 | ✓ |
| C2 | partition-reset: crashed where the cut hit in-flight work | 42/42 | 42/42 | ✓ |
| C2 | Fault landed on in-flight transactions: stall / reset / sigkill, unmodified | 49/60, 42/60, 57/60 | 49/60, 42/60, 57/60 | ✓ |
| C2 | Fault landed: stall / reset, scaffolded | 46/60, 48/60 | 46/60, 48/60 | ✓ |
| C2 | partition-stall runs flagged transaction-outlived-client-timeout | 92/120 | 92/120 | ✓ |
| C2 | HTTP 500s on scaffolded partition-reset | 3109 | 3109 | ✓ |
| C2 | every transaction drained within 135 ms, none leaked (bound, leaks) | ≤135 ms, 0 | ≤135 ms, 0 | ✓ |
| C2 | app-sigkill: kills / unacknowledged commits | 60 / 65 | 60 / 65 | ✓ |
| C2 | app-sigkill restart min/median/max (ms) | 653/654/805 | 653/654/805 | ✓ |
| C2 | R6: optimistic hammer-seat client timeouts at 100 ms/chunk | 130/300 | 130/300 | ✓ |
| C2 | R6: serializable deadlock-pairs timeouts / 503s | 37 / 206 | 37 / 206 | ✓ |
| C2 | R6: the other four mechanisms never time out (total timeouts) | 0 | 0 | ✓ |
| C2 | R6: those four mechanisms' p95 under latency-below | ~1.1-1.3 s | 0.8-1.3 s | **DIFF** |
| C2 | R5: runs logging the advisory duplicate-key 500, matrix / no-Fault reruns | 1 in 420 / 0 in 20 | 1 in 420 / 0 in 20 | ✓ |
| C2 | long-partition slowest request (ms): pessimistic / advisory / serializable / pessimistic scaffolded | 30261/30297/30294/30325 | 30261/30297/30294/30325 | ✓ |
| C2 | hammer-seat jitter, partition/SIGKILL (ms): reps 4-5 and reps 1-3 | 120/100 and 400/250 | 120/100 and 400/250 | ✓ |
| C3 | report files | 52 | 52 | ✓ |
| C3 | measured runs / Correctness violations among them | 49 / 0 | 49 / 0 | ✓ |
| C3 | end-to-end controls flagged | 3/3 | 3/3 | ✓ |
| C3 | unmodified Fault runs that crashed (incl. as-found first runs) | 18/18 | 18/18 | ✓ |
| C3 | uncaught exceptions swallowed by the scaffold | 457 | 457 | ✓ |
| C3 | one-shot: kills / Confirms answered 500 / completed by retry / Holds with exactly one Booking | 274 / 258 / 258 / 800 | 274 / 258 / 258 / 800 | ✓ |
| C3 | unmodified hold-confirm: Bookings created by the retry after a crash (min–max of 40) | 5–32 | 5–32 | ✓ |
| C3 | reaper sweeps killed mid-flight: unmodified / scaffolded | 7 / 24 | 7 / 24 | ✓ |
| C3 | reaper stall: fresh Holds won, stalled vs baseline (of 12) | 0 vs 12 | 0 vs 12 | ✓ |
| C3 | reaper stall: 409s stalled vs baseline | 623 vs 527 | 623 vs 527 | ✓ |

**Discrepancies found by hand (not derivable from the JSON):**

- **R3 top-frame counts (C2 record).** The record's table of top frames (`pool.ts:187` 2,663×, `:47` 1,090×, `:134` 1,049×, `:181` 301×, `:41` 175×) mixes denominators and two of its five numbers do not reproduce. Re-counting the stack traces in the 120 scaffolded C2 app logs (which still exist in the C2 worktree but are **git-ignored and not in the repository**, so this cannot be regenerated from committed evidence): `:187` 2,663 ✓, `:181` 301 ✓, `:41` 175 ✓, but `:47` is **1,474** (not 1,090) and `:134` is **1,136** (not 1,049), plus 120× `uniqueConstraint.ts:37`, 58× `naive.ts:49` and 54× `pool.ts:128`. Also, the same sentence pairs those frame counts with "3,109 500s on `partition-reset`", but the frames total 5,981 across `partition-reset` (3,109) *and* `partition-stall` (2,872 — inferred to be requests the app answered 500 after the client had already timed out: the clients saw no 5xx on those runs). The qualitative claim (the catch-block `ROLLBACK`/`BEGIN` on a dead client is the top frame, hiding the original error) is confirmed. C1's 50 of 53 (`pool.ts:47`) and C3's 250 of 258 reproduce exactly.
- **C2 "30 `Reaper sweep failed` log lines" sits in the app-SIGKILL paragraph** but the lines come from the partition runs (20 `partition-reset`, 10 `partition-stall` in the matrix, 6 more in the long-partition runs); the app-SIGKILL runs produced none (the killed process cannot log). The point it makes — the reaper's own `.catch` survives a dead connection where the request path does not — stands.
- **R5 frequency.** C2 estimates "1 in ~600 same-seat races". The reports support only "1 in 420 matrix runs" (1 in the 70 advisory ones; plus 0 in 20 dedicated reruns); the ~600 denominator (races per run × runs) is not recorded and could not be reproduced, so no rate beyond "rare" is claimed here.
- **Counts that differ only in what they count** (not errors): the C2 record's "420 matrix runs" excludes 20 `c2adv`, 4 `c2long`, 10 `c2ctl` reports; C3's "49 measured" excludes its 3 controls; this exhibit's "540 measured" includes everything that is not a control.

## Test environment

- **Machine (inferred, not recorded in the reports)**: the reports carry no hardware metadata. The sessions that produced them ran on the development Mac this repository lives on — Apple M4 (`Mac16,12`), 10 cores, 16 GB, macOS 27.2.1, Docker Desktop 4.70.0 (engine 29.4.0), Node v25.6.1, k6 v2.2.0 (versions read on this machine while writing the exhibit). Run dates 2026-11-25 (UTC).
- **Postgres**: `postgres:17` (17.10, Debian), the compose service `racetoseat-postgres` on `:5433`, started with `deadlock_timeout=100ms` and `max_connections=600` (`docker-compose.yml`). Server-side timeouts in every report: `statement_timeout=0`, `lock_timeout=0`, `idle_in_transaction_session_timeout=0`, `idle_session_timeout=0`, `tcp_keepalives_idle=7200`.
- **Toxiproxy**: `ghcr.io/shopify/toxiproxy:2.12.0`. C1 used the compose `chaos` profile (`:5434` → `postgres:5432`); C2 ran its own container (`docker run … --network racetoseat_default -p 5440-5449:5440-5449 -p 8475:8474 … -host=0.0.0.0`, API `:8475`) because the compose service publishes only `:5434`/`:8474`. C3's backend-kill needs no proxy.
- **App connection settings**: `pg` pool `max` = `PG_POOL_MAX` (default 500; C3 used 100 to be a good neighbour on the shared Postgres), no `connectionTimeoutMillis`/`idleTimeoutMillis`/`query_timeout` (R4). Client request timeout T = 5 s for C2. `HOLD_TTL_SECONDS` = 8 (hold-expiry) / 120 (hold-confirm), `REAPER_INTERVAL_MS` = 1000 in C3.
- **Load ceiling**: macOS `kern.ipc.somaxconn` is 128 on this machine. Above ~130 simultaneous k6 connections the load generator alone produces connection resets with **no Fault at all** (C1 observed: ≥80 pairs = 160 clients reset; ≤60 pairs clean). Every chaos load is therefore ≤120 concurrent clients (C1: 60 pairs = 120; C2: 60; C3: ≤120) — except C1's as-found first run (150 pairs = 300 requests, over the ceiling; superseded by the 120-client reruns, which agree) — far below the 1,000-concurrent loads of Exhibits A–F. These results say nothing about Faults at that concurrency.

## What this does not show

- **Postgres restart (C4, #51) was not run.** No Fault here takes the *database* down. `pg_terminate_backend` kills individual backends; it is not a crash, a failover, or a restart with recovery.
- **Kill and partition semantics are narrow.** `pg_terminate_backend` fails fast and severs cleanly; it never produced the *commit-sent-but-response-lost* Ambiguous outcome (C3: no Confirm committed-then-lost in 274 kills). That case was exercised only by the network Faults and app-SIGKILL (C2: 1,434 unacknowledged commits across the matrix, all resolved by replay) — and only for Bookings, not for Holds.
- **Toxiproxy's partition heal severs connections.** `partition-stall` heals by tearing down the stalled connections; a real partition that TCP retransmits across would let some in-flight statements finish. The lossless slow link is covered only by `latency-above`.
- **One load shape per Fault family.** C1: `deadlock-pairs` only. C2: `hammer-seat` and `deadlock-pairs`, 60 clients, one short burst; the k6 client does not retry, so retry-storm behaviour under a Fault is not modelled. No `spread-seats` or isolation-pattern run under any Fault.
- **C2's `hammer-seat` window is narrow** (losing requests fail in a few ms), so some timed Faults missed it: the "landed" counts in the tables show how many (e.g. `partition-stall` 49/60 unmodified). A "landed 0/n" cell would be vacuous; none occurs, but several are partial.
- **App-SIGKILL is one kill per run**, and the restart (~650 ms) is the harness's, not a supervisor's.
- **The two formal-derived findings (RF1, RF2) are invisible to these runs by construction.** The Oracles read *stored state after the Fault clears* (ADR-0022): a Booking recreated after Cancel under a reused key (RF1) leaves one row, not two, and a spurious 409 on a same-key retry (RF2) is an HTTP answer about a Booking that does exist exactly once — HTTP responses are never evidence here. The chaos loads also never cancel a Booking and replay its key, and never issue a same-key retry that overlaps the original's commit. A clean chaos run therefore says nothing about either; they were found by model checking (F4) and are not reproduced by any run in this exhibit.
- **Holds under Fault: only `pessimistic`** (ADR-0017), only backend-kill, only 12–100 Holds per run. `POST /holds` retries have no ledger of fresh-hold keys, so there is no "exactly one Hold per key" Oracle yet.
- **Control strength.** The end-to-end controls show the pipeline *detects* a violation under each Fault; for partition/SIGKILL the violation can come from the replay race rather than the faulted load. The C3 controls corrupt the scratch DB directly and prove the pipeline, not `pessimistic`.
- **Unmodified vs scaffolded.** Unmodified runs mostly judge little (above); scaffolded runs judge a program that, as shipped, would have crashed. Neither is a production deployment with a process supervisor and timeouts.
- **Unit-control status is cited, not re-run** for this exhibit; their pass/mutation results come from C1/C2/C3.
- **NFR-style numbers are not in scope.** Latency here describes behaviour under injected slowness (R6), not the throughput/p99 comparison of Exhibit C.

## Reproducing

```bash
docker compose up -d                                   # Postgres on :5433
docker run -d --name c2-toxiproxy --network racetoseat_default \
  -p 5440-5449:5440-5449 -p 8475:8474 ghcr.io/shopify/toxiproxy:2.12.0 -host=0.0.0.0
npx tsx load-harness/chaos/matrix.ts --reps 5          # C2 matrix (resumable; ~1 h)
npm run chaos:holds -- --mode hold-expiry --survive-uncaught --kill-fraction 0.3   # C3
npm run chaos -- --survive-uncaught --kill-fraction 0.3                            # C1
# R1 fix reruns (section E), after #53:
npm run chaos -- --concurrency 60 --label r1-after-rep1                            # C1, repeat for rep2..
npx tsx load-harness/chaos/matrix.ts --label-prefix r1-after- --mechanisms pessimistic,naive \
  --faults partition-stall,partition-reset --survive-faults none --reps 5           # C2 cells
npm run chaos:holds -- --mode hold-confirm --concurrency 100 --attempts-per-hold 1 --kill-interval-ms 10 --label r1-after-hold-confirm-oneshot-rep1
npm run chaos:holds -- --mode hold-expiry --reaper-stall-seats 3 --label r1-after-hold-expiry-reaperstall-rep1
npm run harness:aggregate -- --exhibit h               # this exhibit, from docs/evidence/chaos/*.json
npx vitest run test/chaos                              # the unit controls
```

## Next step

Seven chaos-observed (R1–R7) and two formal-derived (RF1–RF2) Robustness findings are filed as fix tickets #53–#61 (drafts in `docs/phase6-robustness-ticket-drafts.md`), which satisfies the umbrella's "every Robustness finding is listed with a follow-up issue link". Phase 6 stays open until the formal Exhibit G (F5) lands and the umbrella is closed out.
