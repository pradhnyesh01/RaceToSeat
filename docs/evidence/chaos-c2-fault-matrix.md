# Chaos C2: latency, partition and app SIGKILL across all six mechanisms, measured on unmodified code

Issue #49, under umbrella #42, building on C1 (`chaos-c1-tracer-findings.md`). This is the C2 findings record, kept as found. It is **not** Exhibit H (C5, #52). Definitions (Fault, Ambiguous outcome, Oracle, Correctness violation, Robustness finding) are in `CONTEXT.md`; the reasoning is in ADR-0022 and ADR-0023.

Raw per-run reports are `docs/evidence/chaos/c2-*.json` (one per run; the `.app.log` captures are git-ignored). Regenerate the tables below with `npx tsx load-harness/chaos/summarize.ts`.

## Headline

| | |
|---|---|
| Correctness violations (any Oracle failing) | **0 in 420 matrix runs** (6 mechanisms x 2 loads x 5 Faults, 5 repeats each; plus 120 `--survive-uncaught` runs of the two partition Faults; plus 4 long-partition runs). **No mechanism was cut: all six ran.** |
| Ambiguous outcomes actually exercised | 1,434 Bookings committed that no client was ever told about (`latency-above` alone: 854), every one resolved by the Idempotency-Key replay to exactly one Booking; Oracle 3 passed in every run |
| Robustness findings | R1/R2 and R3 **extended** to all six mechanisms; **R4 resolved: it is real** (a partition stalls requests, transactions and row locks for the whole partition; nothing in the stack gives up); two **new** findings, R5 (advisory 500) and R6 (latency amplification by retry loops) |
| Negative controls | 10 of 10 end-to-end controls flagged by Oracle 1 (`naive` on the no-`UNIQUE` scratch DB under each of the 5 Faults, 2 repeats); 9 new unit tests for the new Faults / stall observer, 4 of which fail when the drivers are neutered |
| Production code changed | None: `src/` and `db/schema.sql` untouched |

**Read the crash numbers with C1's caveat.** On unmodified code the app dies on the first torn connection (R1/R2), so the `partition-*` rows of the *unmodified* section judge less than they appear to: the app is restarted by the harness, then keys are replayed. The `--survive-uncaught` section (ADR-0022 scaffolding) is where the Oracles see requests continue through the Fault. The two sections are never merged.

## Method

- **Isolation.** Every run uses its own throwaway database (`--db scratch`: the real `db/schema.sql` applied verbatim, nothing dropped, created and dropped within the run), a per-run `application_name=c2-app-<tag>` stamped on the app's connections through its `DATABASE_URL` (no `src/` change), and a per-run Toxiproxy proxy `c2-<tag>` created and deleted through the API. The shared dev database was never written. App ports 3200-3299, proxy ports 5440-5449. The backend killer is additionally scoped by `application_name` (`appName`) so it cannot match another session's backends.
- **Toxiproxy server.** The compose `toxiproxy` service only publishes `:5434`/`:8474`, so this ticket ran its **own** Toxiproxy container (`docker run -d --name c2-toxiproxy --network racetoseat_default -p 5440-5449:5440-5449 -p 8475:8474 ghcr.io/shopify/toxiproxy:2.12.0 -host=0.0.0.0`; API `:8475`, upstream `racetoseat-postgres:5432`). `docker-compose.yml` is untouched.
- **Loads** (existing k6 scripts, each gaining one optional `REQUEST_TIMEOUT` env, default = k6's own 60s so nothing else changes): `hammer-seat` (60 clients, one seat) and `deadlock-pairs` (30 pairs x both orderings = 60 clients). 60 requests keeps the load generator under macOS's 128-deep listen backlog (C1 note).
- **Client request timeout T = 5s**, set per run through that env.
- **Faults**, all injected between app and Postgres:
  - `latency-below`: Toxiproxy `latency` toxic, 100 ms on every Postgres-to-app chunk, i.e. each protocol round trip costs +100 ms. A normal request is 0.4-0.6 s, well under T.
  - `latency-above`: 800 ms per chunk. Connection setup alone (~4 chunks) is ~3.2 s and a booking adds 6+ round trips, so **every** request exceeds T (measured: 3,600 of 3,600 requests timed out client-side). 800 ms, not larger, so transactions *begin* before the client gives up (at 1,500 ms the handshake alone outlasts T and no transaction ever starts, which would judge nothing). The toxic is removed when the load ends; removal flushes the delayed bytes, so in-flight transactions complete after the client has given up.
  - `partition-stall`: `timeout` toxic (timeout=0) on both directions: traffic is swallowed, connections stay open. Applied 20-420 ms (jittered, per repeat) after the first app transaction appears in Postgres, held 7 s (> T), then healed (toxic removed).
  - `partition-reset`: `reset_peer` toxic on both directions, same timing; every connection is RST for 7 s.
  - `app-sigkill`: `SIGKILL` of the app's whole process tree (`tsx` wrapper and its server child) 20-270 ms after the first app transaction, then the harness restarts it (restart ~650 ms: min 653, median 654, max 805). One kill per run: a sub-second load is over before a second kill could land.
- **Why a 40 ms base latency on the partition and SIGKILL Faults.** A sub-second, fast-failing load means a timed cut often lands after the work is done. 40 ms per chunk stretches each transaction to a few hundred ms so cuts land mid-transaction. It is recorded (`baseLatencyMs`) in every report. Even so, a Fault landed on in-flight transactions in 49/60 (`partition-stall`), 42/60 (`partition-reset`) and 57/60 (`app-sigkill`) unmodified runs (46/60 and 48/60 in the scaffolded ones); the matrix tables show that count per cell as "landed". `hammer-seat` has by far the narrowest window (losing requests fail in a few ms), so reps 4-5 used a tighter jitter (120/100 ms) than reps 1-3 (400/250 ms); each report records its own.
- **Timing anchor.** The timed Faults are triggered by the first app transaction seen in `pg_stat_activity`, not by a fixed delay from launching k6 (a first attempt with a fixed delay landed after the load had already finished and was thrown away).
- **Per run:** four Oracles evaluated after the Fault clears, the app is waited on, and every Idempotency Key is replayed (`20s` per-request cap). A stall observer samples the app's own backends every 50 ms (open transactions, row-lock holders via `backend_xid`, oldest transaction age) without taking any lock, and after the Fault clears measures **how long until every app transaction has ended** ("drain").
- **Repeats and variants.** 5 repeats of every cell. Two variants kept apart: unmodified code (all 5 Faults, 300 runs) and `--survive-uncaught` scaffolding (the two partition Faults only, 120 runs: the only Faults that kill pooled connections and so crash the unmodified app; `latency-*` and `app-sigkill` runs showed no crash on unmodified code, so they need no scaffolded twin).

## Toxiproxy behaviours the Faults rest on (probed, not assumed; Toxiproxy 2.12.0)

- Removing a `latency` toxic **flushes** buffered bytes: an in-flight query completes immediately. A lossless slow link.
- Removing a `timeout` (timeout=0) toxic does **not** resume the session: the swallowed bytes are gone, so the proxy tears the stalled connection down and both ends see it close. Healing this partition therefore means "new connections work again"; stalled connections die at the heal. A real partition that TCP retransmits across would not do this, so `partition-stall` is "a partition whose heal severs the connections that lived through it", a harsher heal than a lossless one. The lossless slow-link behaviour is covered by `latency-above`.
- `reset_peer`: connections are RST immediately.

## Results

Cell legend: Oracle-clean runs / total, Fault landed on in-flight transactions, app crashed (Robustness), commits no client was told about (`unack`), longest app transaction open (`tx`), `LEAK` = transactions that never drained. A `Fault landed 0/n` cell is a vacuous result for that cell and says so rather than hiding it.

### Unmodified production code

300 runs; **Correctness violations: 0**. Cell legend: Oracle-clean runs/total · Fault landed on in-flight transactions · app process crashed (Robustness) · commits no client was told about · longest app transaction open · leaked (never-draining) transactions.

#### latency-below

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤414ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤400ms |
| unique_constraint | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤521ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤562ms |
| pessimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤513ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤551ms |
| optimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤4.9s | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤1.2s |
| advisory | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤505ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤521ms |
| serializable | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤515ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤634ms |

#### latency-above

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤1.3s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤1.3s |
| unique_constraint | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤1.3s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤1.3s |
| pessimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤2.1s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤2.1s |
| optimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤2.1s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤2.2s |
| advisory | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤2.1s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 150 · tx≤2.0s |
| serializable | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 5 · tx≤2.0s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 74 · tx≤2.1s |

#### partition-stall

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 3/5 · crash 5/5 · unack 1 · tx≤7.1s | ✅ 5/5 · landed 5/5 · crash 5/5 · unack 49 · tx≤7.1s |
| unique_constraint | ✅ 5/5 · landed 3/5 · crash 5/5 · tx≤7.1s | ✅ 5/5 · landed 4/5 · crash 5/5 · tx≤7.2s |
| pessimistic | ✅ 5/5 · landed 4/5 · crash 5/5 · tx≤7.1s | ✅ 5/5 · landed 5/5 · crash 5/5 · unack 3 · tx≤7.2s |
| optimistic | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤7.4s | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤7.3s |
| advisory | ✅ 5/5 · landed 4/5 · crash 5/5 · unack 1 · tx≤7.1s | ✅ 5/5 · landed 3/5 · crash 5/5 · unack 59 · tx≤7.1s |
| serializable | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤7.2s | ✅ 5/5 · landed 3/5 · crash 5/5 · tx≤7.2s |

#### partition-reset

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 2/5 · crash 4/5 · unack 1 · tx≤173ms | ✅ 5/5 · landed 3/5 · crash 4/5 · tx≤176ms |
| unique_constraint | ✅ 5/5 · landed 3/5 · crash 5/5 · unack 1 · tx≤228ms | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤211ms |
| pessimistic | ✅ 5/5 · landed 2/5 · crash 3/5 · tx≤218ms | ✅ 5/5 · landed 3/5 · crash 4/5 · tx≤208ms |
| optimistic | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤236ms | ✅ 5/5 · landed 5/5 · crash 5/5 · tx≤309ms |
| advisory | ✅ 5/5 · landed 3/5 · crash 5/5 · tx≤167ms | ✅ 5/5 · landed 3/5 · crash 3/5 · unack 60 · tx≤224ms |
| serializable | ✅ 5/5 · landed 3/5 · crash 4/5 · tx≤218ms | ✅ 5/5 · landed 5/5 · crash 5/5 · unack 1 · tx≤258ms |

#### app-sigkill

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 4/5 · crash 0/5 · tx≤177ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤170ms |
| unique_constraint | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 3 · tx≤230ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤217ms |
| pessimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤169ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤153ms |
| optimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤145ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤282ms |
| advisory | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤206ms | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 60 · tx≤211ms |
| serializable | ✅ 5/5 · landed 4/5 · crash 0/5 · tx≤214ms | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 2 · tx≤268ms |

#### Stall and drain per Fault (R4)

| Fault | runs | longest app tx | max row-lock holders | longest drain after Fault cleared | transactions that never drained | client timeouts (total) | 5xx answers (total) |
|---|---|---|---|---|---|---|---|
| latency-below | 60 | 4.9s | 60 | 109ms | 0 | 167 | 0 |
| latency-above | 60 | 2.2s | 60 | 134ms | 0 | 3600 | 0 |
| partition-stall | 60 | 7.4s | 60 | 110ms | 0 | 3101 | 0 |
| partition-reset | 60 | 309ms | 60 | 3ms | 0 | 0 | 0 |
| app-sigkill | 60 | 282ms | 60 | 3ms | 0 | 0 | 0 |

### With `--survive-uncaught` harness scaffolding (reported separately, never merged)

120 runs; **Correctness violations: 0**. Cell legend: Oracle-clean runs/total · Fault landed on in-flight transactions · app process crashed (Robustness) · commits no client was told about · longest app transaction open · leaked (never-draining) transactions.

#### partition-stall

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 3/5 · crash 0/5 · tx≤7.1s | ✅ 5/5 · landed 3/5 · crash 0/5 · tx≤7.1s |
| unique_constraint | ✅ 5/5 · landed 3/5 · crash 0/5 · tx≤7.2s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 89 · tx≤7.2s |
| pessimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤7.1s | ✅ 5/5 · landed 2/5 · crash 0/5 · tx≤7.1s |
| optimistic | ✅ 5/5 · landed 4/5 · crash 0/5 · tx≤7.3s | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 30 · tx≤7.4s |
| advisory | ✅ 5/5 · landed 4/5 · crash 0/5 · tx≤7.1s | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 59 · tx≤7.1s |
| serializable | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 1 · tx≤7.1s | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 1 · tx≤7.2s |

#### partition-reset

| mechanism | hammer-seat | deadlock-pairs |
|---|---|---|
| naive | ✅ 5/5 · landed 2/5 · crash 0/5 · tx≤173ms | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 87 · tx≤167ms |
| unique_constraint | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 2 · tx≤1.9s | ✅ 5/5 · landed 2/5 · crash 0/5 · tx≤203ms |
| pessimistic | ✅ 5/5 · landed 4/5 · crash 0/5 · unack 1 · tx≤215ms | ✅ 5/5 · landed 5/5 · crash 0/5 · unack 40 · tx≤209ms |
| optimistic | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤2.8s | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤309ms |
| advisory | ✅ 5/5 · landed 3/5 · crash 0/5 · tx≤225ms | ✅ 5/5 · landed 3/5 · crash 0/5 · unack 29 · tx≤220ms |
| serializable | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤793ms | ✅ 5/5 · landed 5/5 · crash 0/5 · tx≤278ms |

#### Stall and drain per Fault (R4)

| Fault | runs | longest app tx | max row-lock holders | longest drain after Fault cleared | transactions that never drained | client timeouts (total) | 5xx answers (total) |
|---|---|---|---|---|---|---|---|
| partition-stall | 60 | 7.4s | 60 | 109ms | 0 | 2872 | 0 |
| partition-reset | 60 | 2.8s | 60 | 4ms | 0 | 0 | 3109 |


### R4 directly: how long does a request / lock stall? (long partitions, unmodified code, 60s client timeout)

Four runs on `deadlock-pairs` with a 30 s `partition-stall` and a 60 s client timeout (so the *client* does not give up first); reports `c2long-*.json`:

| mechanism | slowest request | oldest app transaction | row-lock holders | outcome at heal | drained after heal |
|---|---|---|---|---|---|
| pessimistic | 30,261 ms | 30,076 ms | 26 | app crashed (R1), 60/60 requests got no answer | 2 ms |
| advisory | 30,297 ms | 30,056 ms | 11 | app crashed (R1), 60/60 no answer | 1 ms |
| serializable | 30,294 ms | 30,092 ms | 22 | app crashed (R1), 60/60 no answer | 12 ms |
| pessimistic, `--survive-uncaught` | 30,325 ms | 30,113 ms | 30 | all 60 requests answered **HTTP 500** at the heal | 3 ms |

So: **yes, a request and its row locks stall for exactly as long as the partition lasts, nothing gives up on its own** (no `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, pool acquire timeout or client timeout exists, and TCP keepalive can't fire because the proxy accepts the connection), and the stall ends only when the partition does. The flip side is also measured: once the Fault clears, **every transaction drained within 135 ms in all 420 matrix runs, with no leak** (`LEAK` never appears), because the heal tears the connections down and Postgres rolls the transactions back. Oracle 4 stayed green in every run. The sampler shows up to 30 sessions holding row locks (an assigned xid) throughout; a seat locked that way cannot be claimed by anyone else for the whole partition (inferred from the lock-holder counts and the locking rules, not separately probed), which is the user-visible cost.

## Findings

| id | finding | class | evidence |
|---|---|---|---|
| R1 | Process exits when a *checked-out* connection errors: confirmed on all six mechanisms, via two new triggers (a partition heal that tears down stalled connections, a `reset_peer` partition). `pool.on("error")` alone would not fix it (C1: pg-pool drops its listener on checkout) | Robustness | `partition-stall`: **60/60** unmodified runs crashed (51 `Client`-event, 9 `BoundPool`-event); `partition-reset`: **52/60** (42/42 where the cut hit in-flight work) |
| R2 | Process exits on an *idle pooled* connection error | Robustness | 9 `partition-stall` runs died only with an unhandled `BoundPool` error (`Emitted 'error' event on BoundPool instance`): the heal found nothing but idle pooled connections to tear down |
| R3 | The catch-block `ROLLBACK` masks the original error on a dead connection. **Not just `withTransaction`**: the same `await client.query("ROLLBACK")` / `BEGIN` on a dead client is the top frame in `withSerializableTransaction` (`pool.ts:134`) and `withDeadlockRetry` (`pool.ts:187`, `:181`) too. Infrastructure failure is returned as an unclassified `500` | Robustness | scaffolded runs: 3,109 `500`s on `partition-reset`; top frames `pool.ts:187` 2,663x, `:47` 1,090x, `:134` 1,049x, `:181` 301x, `:41` 175x |
| R4 | No timeouts anywhere. **Impact now measured**: a partition stalls every in-flight request, its transaction and its row locks for the whole partition; transactions outlive the client's timeout (92 of 120 partition-stall runs flagged `transaction-outlived-client-timeout`); the stall is bounded only by the partition | Robustness | table above; longest app transaction 7.4 s under a 7 s partition, 30.1 s under a 30 s one |
| R5 (new) | `advisory`: a loser's single `SELECT id, status, pg_try_advisory_xact_lock(...)` can take its snapshot (status `available`), then the winner commits and releases the lock, and only then does the lock call run, so it succeeds against a stale status. The `UNIQUE(seat_id)` backstop refuses the insert (no double-booking) but the route returns an unclassified **HTTP 500** instead of `409`. **Not Fault-dependent** (surfaced in a replay hammer) and rare | Robustness (latent, pre-existing) | 1 occurrence in the 420 runs (`c2-partition-stall-advisory-hammer-seat-rep1`, `500` on the replay; log: `23505 booking_seats_seat_id_key` at `advisory.ts:71`); not reproduced in 20 further no-Fault advisory hammer runs (`c2adv-nofault-*`); **deterministically reproduced** by `load-harness/chaos/repro-advisory-snapshot-race.ts` (a `pg_sleep` widens the window) |
| R6 (new) | Retry loops multiply latency: at only 100 ms per chunk (**below** T) `optimistic` on `hammer-seat` times out 26 of 60 clients in **every** run (130/300), `serializable` on `deadlock-pairs` times out 37 and answers 206 `503 retry_exhausted`, while the other four mechanisms never time out (p95 ~1.1-1.3 s vs 5 s). Not a safety issue: a design trade-off of ADR-0009/0011/0013, recorded because it is where "below the timeout" is not below it | Robustness (performance) | `latency-below` tables |

**Correctness violations: none.** R5 deserves a note on why it is *not* one: Oracle 1 (mutual exclusion) is a statement about stored state, and the `UNIQUE(seat_id)` constraint (ADR-0008) kept the stored state correct; what failed was the HTTP answer. It is, however, a case where a mechanism leans on the backstop for correctness while its own check is racy, which is what ADR-0013 says openly about `serializable` and not yet about `advisory`. Each Robustness finding becomes its own ticket under C5 (#52); none is fixed here, per the measure-first policy.

Not findings, but worth reading off the tables: `app-sigkill` is the cleanest Fault: no crash (the kill is the Fault), transactions drain in ~3 ms (Postgres notices the dead client at once), the restart is ~650 ms, and the replay recovers every key (60 kills, 65 unacknowledged commits, all Oracles green). The reaper's own sweep catches a dead connection and logs `Reaper sweep failed` instead of crashing (30 log lines), i.e. it already handles the error that the request path does not.

## Negative controls (ADR-0023)

1. **Unit controls**, `test/chaos/c2.test.ts` (9 tests) and one added to `test/chaos/faults.test.ts`: the stall sampler counts an app transaction, its lock-holding and age and ignores another application's; the drain wait reports a held transaction as stuck past its deadline and returns once it ends; the app-kill driver kills exactly `maxKills` times, only after its load anchor, and records what was in flight; and, against a real Toxiproxy (skipped when none is reachable), latency really delays a round trip and removal restores it, a stall partition really silences a connection and its heal really severs it, a reset partition resets at once and leaves nothing behind. Mutation check: neutering `startNetworkFault` and the drain wait makes 4 of the 9 fail. The `appName` scoping of the backend killer is pinned by its own test.
2. **End-to-end controls**, `c2ctl-*.json`: `naive` on the scratch DB with `UNIQUE(seat_id)` dropped, `hammer-seat`, run under **each of the five new Faults**, 2 repeats, `--expect-violations`: all 10 runs flagged by Oracle 1 (one doubly-claimed seat each), Oracles 2-4 correctly green. (Caveat on strength: in the partition/SIGKILL controls the double claim can come from the post-Fault replay, which is itself a 60-way race, rather than from the faulted load; the control shows the pipeline still *detects* under every Fault, not that each Fault is what produced the violation.) The control's control, the same `naive` workload on the real schema under the same Faults, is the `naive` rows of the matrix: all green.

## Not covered here (explicitly)

Hold/confirm/reaper under Fault is C3 (#50). Postgres restart is C4 (#51). The partition heal here is lossy by Toxiproxy's design (see above). Only one kill per `app-sigkill` run and short loads; the k6 client does not retry, so retry-storm behaviour under a Fault is not modelled. `--survive-uncaught` was run for the two partition Faults only. R5's frequency is unknown beyond "1 in ~600 same-seat races"; a dedicated high-concurrency advisory hammer would be needed to rate it.

## Reproducing

```bash
docker compose up -d                                   # Postgres on :5433
docker run -d --name c2-toxiproxy --network racetoseat_default \
  -p 5440-5449:5440-5449 -p 8475:8474 ghcr.io/shopify/toxiproxy:2.12.0 -host=0.0.0.0
npx tsx load-harness/chaos/matrix.ts --reps 5          # the whole matrix (resumable; ~1h)
npx tsx load-harness/chaos/summarize.ts                # the tables above
npx tsx load-harness/chaos/run.ts --strategy pessimistic --load deadlock-pairs --fault partition-stall \
  --db scratch --toxiproxy-api http://localhost:8475 --proxy-port 5440 --app-port 3200 \
  --request-timeout-ms 5000 --base-latency-ms 40 --partition-ms 7000   # a single cell
npx tsx load-harness/chaos/repro-advisory-snapshot-race.ts   # R5
npx vitest run test/chaos                              # the unit controls
```
