# Chaos C3: hold → confirm → reaper under backend-kill (`pessimistic`), measured on unmodified code

> **Finding numbering (added by C5, #52 — the text below is as written at C3 time).** Exhibit H uses one canonical list, R1–R7. This record's **R1, R3 and R4 keep their numbers**; its **"R5 (new)" — the stalled reaper — is canonically R7**, because C2's record had already used R5 for the `advisory` stale-snapshot 500 (and R6 for retry-loop latency). Wherever this record says "R5" read **R7**. See [Exhibit H](exhibit-h-phase6-chaos.md) and [../phase6-robustness-ticket-drafts.md](../phase6-robustness-ticket-drafts.md).

Issue #50, under umbrella #42. This is the C3 findings record, not Exhibit H (that is C5, #52). Definitions (Fault, Ambiguous outcome, Oracle, Correctness violation, Robustness finding) are in `CONTEXT.md`; reasoning in ADR-0022 (what "correct under chaos" means) and ADR-0023 (negative controls without production toggles). It extends [chaos-c1-tracer-findings.md](chaos-c1-tracer-findings.md) from bookings to the Phase 5 hold lifecycle.

Per-run JSON reports are in `docs/evidence/chaos/c3-*.json` (52 runs; app logs sit beside them locally but are gitignored).

## Headline

| | |
|---|---|
| Correctness violations on `pessimistic` | **0** across 49 measured runs (every run: all 4 base Oracles + 2 hold extensions green) |
| Robustness findings | **5**: C1's R1, R3 and R4 reproduced on the hold flow, plus **R5 (new)**: a stalled reaper blocks unrelated Hold/Confirm. R2 not re-tested |
| Negative controls | 3 end-to-end (each makes the pipeline go red, run with `--expect-violations`) + 15 new unit tests; mutation: neutering the new Oracles fails 4 of their tests, neutering Oracle 4's expiry predicate fails 3 |
| Production code changed | **None.** `src/` and `db/schema.sql` untouched |

Read the zero with its caveats. On unmodified code the app dies on the first killed connection (R1), so unmodified runs judge little — they are reported apart from the scaffolded runs (ADR-0022) and never merged with them. The Fault is `pg_terminate_backend`, which fails fast and severs cleanly; it is not a network Fault, so the *commit-sent-but-response-lost* Ambiguous outcome was never observed (see "What this does not show").

## Method

- **App**: `tsx src/server.ts` unmodified as a child process, `BOOKING_STRATEGY=pessimistic`, so `startReaper` runs exactly as in production (server.ts starts it after `listen`). Env only: `HOLD_TTL_SECONDS`, `REAPER_INTERVAL_MS=1000`, `PG_POOL_MAX=100` (good neighbour on the shared Postgres), `PGAPPNAME=racetoseat-c3-app`. Connects straight to Postgres — backend-kill needs no Toxiproxy, so none was used.
- **Isolation from sibling sessions**: every run uses its own throwaway database holding the full real `db/schema.sql` (`createScratchDb(url, [])` — nothing dropped except the duplicate-confirm control), app ports 3300–3399 only (enforced by the harness). The Fault is scoped by database (`current_database()`), by an application_name allow-list (`onlyApplicationName`, a 3-line additive option in `faults.ts`, with its own test) and by the harness's own exemption. A run refuses to start unless it is connected to a `racetoseat_chaos_*` database; the report records `applicationNamesSeen` (app backends carried `racetoseat-c3-app`, the harness's `racetoseat-chaos`, nothing else).
- **Entry point**: `npm run chaos:holds` → `load-harness/chaos/runHolds.ts` (new; reuses `AppUnderTest`/`runK6` from `run.ts`, whose only change is `export` keywords and a "run main only when invoked directly" guard, so C2's edits to that file should merge cleanly). Holds are seeded through the real `POST /holds` before the Fault starts, then read back from the database as the ledger.
- **Two loads**:
  - `hold-expiry`: Phase 5's `hold-expiry-race.k6.js`, unchanged — 12 seats, every Hold already past its 8 s TTL, then 5 confirms + 5 fresh `POST /holds` per seat race the reaper (120 VUs; ≤130 is the clean ceiling here, C1's `somaxconn` finding). The Fault runs through the load and 3 s after it, so the reaper's own timer-driven sweeps are exposed.
  - `hold-confirm` (new `hold-confirm-race.k6.js`): confirms against still-live Holds (TTL 120 s). After the Fault clears, every Confirm is retried — the Ambiguous-outcome recovery. Variants: 3 concurrent attempts per Hold (40 holds), and **one-shot** (100 holds, 1 attempt each, kill every 10 ms at 0.5) so each killed Confirm can only be completed by the retry.
  - `--reaper-stall-seats 3` (hold-expiry): the harness row-locks three extra expired seats so the reaper's sweep blocks mid-statement; a random kill almost never catches a microsecond sweep (0 sweeps killed in the first 7 scaffolded runs), this does it reliably.
- **Fault**: `pg_terminate_backend` on in-transaction app backends, swept every 40 ms (10 ms for one-shot), each killed with p=0.5 (0.3 for the 3-attempt/hold-expiry scaffolded runs), exactly as C1.
- **Judging**: after the Fault clears the app is restarted if it crashed, the harness waits ≥3 reaper ticks past both the last expiry and the heal, retries Confirm on every Hold, then runs the Oracles on stored state with a 2 s liveness grace.

### Oracles

The four base Oracles run unchanged (C1's 28 tests still green). Oracle 1 already covers *no seat in both a Hold and a Booking* (and seat/hold-claim agreement); Oracle 4 already covers *no seat stuck `held` past expiry + grace* — C3 is the first run that exercises that branch. Two Hold extensions (`holdOracles.ts`):

- **Oracle 2 ext — no Booking from an expired Hold.** Holds are deleted on resolution (ADR-0020), so the harness snapshots each Hold's `held_until` (microsecond text) from the database before the Fault and flags any Booking under `confirmIdempotencyKey(holdId)` (imported from `src/strategies/pessimisticConfirm.ts`, not copied) with `created_at >= held_until`. `created_at` is the confirm transaction's start, ≤ the instant confirm's own check ran, so a correctly accepted confirm can never look late.
- **Oracle 3 ext — a retried Confirm on a provably live Hold yields exactly one Booking.** The base Oracle 3 only demands "at most one"; a live Hold has no excuse to end with zero.

## Results

All Oracles green in every row.

| group | runs | kills | k6 outcomes (sum) | app exits | notes |
|---|---:|---:|---|---:|---|
| baseline, no Fault: hold-expiry / hold-confirm | 1 / 1 | 0 | 201:12 409:527 410:49 / 201:84 409:36 | 0 | clean ceiling; 0 unanswered |
| **unmodified** hold-expiry | 5 (+1 first run) | 40 (+8) | 0:488 409:275 410:71 | 5 (+1) | crash on first kill every time |
| **unmodified** hold-confirm | 8 (+1) | 50 (+1) | 0:755 201:181 409:24 | 8 (+1) | after each crash, retry created 5–32 of 40 Bookings |
| **unmodified** hold-expiry + reaper stall | 3 | 15 | 0:346 409:15 410:12 500:1 | 3 | 7 reaper sweeps killed mid-flight |
| *scaffolded* hold-expiry | 6 (+1) | 84 (+9) | 201:72 409:2830 410:198 500:78 | 0 | 84 uncaught exceptions swallowed |
| *scaffolded* hold-confirm, 3 attempts/hold | 8 (+1) | 24 (+15) | 201:835 409:102 500:23 | 0 | siblings cover every killed attempt: 0 Bookings created by the retry |
| *scaffolded* hold-confirm, **one-shot** | 8 | **274** | 201:542 500:258 | 0 | **258 Confirms failed with 500, all 258 completed by the retry: exactly one Booking per Hold, 800/800** |
| *scaffolded* hold-expiry + reaper stall | 4 | 78 | 409:2195 410:171 500:56 | 0 | 24 reaper sweeps killed mid-flight, all seats reaped after heal |

("+n" = the as-found first runs, `c3-first-*`, which ran before the heal-wait and report fields were finalized; their verdicts agree.)

What the Oracles saw, per claim:

- **No double-claim**: Oracle 1 clean in all 49 runs, including those where Confirm, fresh `POST /holds` and reaper sweeps were killed concurrently.
- **No late Confirm**: across 12 expired Holds × 5 confirms × 20 hold-expiry fault runs, zero Bookings under any expired Hold's confirm key (the unmodified post-expiry confirms came back 410/404 as designed).
- **No stuck seat**: every hold-expiry run ended with every seat `available`, zero `holds`/`hold_seats` rows left, including the 7 + 24 reaper sweeps killed mid-statement — the single-statement chained CTE is atomic, so no half-reaped state (Oracle 1's seat/claim agreement and Oracle 4 would flag one; both clean).
- **Retried Confirm**: in the 8 one-shot runs 258 Confirms died with a 500 (the transaction rolled back, the Hold stayed live); the retry produced exactly one Booking each. 0 of the 258 had committed despite the error.

## Decision: the `--survive-uncaught` scaffold (ADR-0022)

**Needed here exactly as in C1, and reported separately.** All 18 unmodified runs with a Fault crashed on the first killed connection (R1), and a hold-confirm run's 120 requests were mostly refused (`status 0`) once the process was gone: they pass, but mostly because nothing ran. The scaffolded runs (preloaded `uncaughtException` swallow, `src/` untouched, 457 swallowed exceptions counted) are where the Oracles are exercised across many kills. The scaffold swallows only the crash; the reaper's own error handling (`startReaper`'s `.catch`) is production code and ran for real (24 logged `Reaper sweep failed` in the stalled runs). Unmodified and scaffolded evidence is never combined.

## Robustness findings (none fixed — measure first)

| id | finding | evidence |
|---|---|---|
| R1 | Process exits on a killed *checked-out* connection (unhandled `Client` `'error'`). Applies to every hold/confirm/reaper path: reproduced 18/18 unmodified Fault runs; in 3/3 reaper-stall runs the reaper's own sweeps were killed in the same window | `c3-unmodified-*` |
| R3 | `withTransaction`'s `ROLLBACK` throws over the original error: top frame `pool.ts:47` in 250 of 258 logged confirm 500s; every client sees a bare `500` (only 201/409/410/404 are designed for confirm) | `c3-survive-hold-confirm-oneshot-*` logs |
| R4 | No statement/lock/idle-in-tx timeouts (server `pg_settings` all 0 in every report). C3 now shows an impact: see R5 | reports' `serverTimeouts`, R5 probe |
| **R5 (new)** | **A stalled reaper blocks unrelated Holds and Confirms.** `runReaperSweep` is one `UPDATE … WHERE status='held' AND held_until < now()`; if it blocks on a single row-locked expired seat (a leaked lock, a slow transaction), it keeps its row locks on every expired seat it already updated, so `POST /holds`/confirm `FOR UPDATE NOWAIT` on those seats fail with `55P03` → `409`. Observed: with 3 locked bait seats and no Fault, 0 of 12 fresh Hold attempts won in the 3.5 s window (baseline: 12/12); `623×409` (baseline 527). Verified directly: with a locked expired seat, a blocked sweep left `NOWAIT` on 5 other expired seats failing with `55P03`. Heals once the lock clears (all seats `available`). With R4 (no `lock_timeout`) a permanently leaked lock stalls the reaper indefinitely | `c3-control-reaperstall-nofault`, `c3-*reaperstall*` |

R2 (idle pooled client death) was not re-run here. Each finding becomes its own ticket under C5 (#52); none is filed or fixed here.

Candidate fix directions, not tried: per-checkout `client.on('error')` (R1; `pool.on('error')` alone covers only R2, see C1), `lock_timeout` on the reaper's sweep or `FOR UPDATE SKIP LOCKED` in its UPDATE's candidate selection (R5).

## Negative controls

- **Unit** (`test/chaos/holdOracles.test.ts`, 15 tests; `faultScoping.test.ts`, 1): late Booking (+ boundary at expiry and ±1 µs), live Hold with no Booking, live Hold with two Bookings, each with a clean twin; half-applied Reaper shapes (seat reset but `hold_seats` left; `hold_seats` gone but seat `held`; fully reaped = clean) and a Confirm that leaves a Hold behind. Mutations by hand: neuter the two new Oracles' violations → 4 tests fail; make the late-confirm predicate `false` → 2 fail; make it `>` instead of `>=` → 1 fails (the boundary test); neuter Oracle 4's expiry predicate → 3 fail (2 existing + 1 new); accept any count in the exactly-one check → 2 fail.
- **End-to-end** (`--expect-violations`, all exit 0 only because something was flagged): `--sabotage late-confirm` (a post-expiry Booking inserted into the scratch DB) → the Oracle 2 extension fails, nothing else; `--sabotage duplicate-confirm` (scratch DB without the idempotency UNIQUE, a second Booking under one confirm key) → Oracle 2, Oracle 3 and the Oracle 3 extension fail; `--reaper-interval-ms 3600000` (config only — the reaper never ticks) → Oracle 4 flags all 12 seats. The sabotage corrupts the scratch database directly because the only way to make `pessimistic` itself violate a Hold guarantee would be to weaken production code, which ADR-0023 rules out; this proves the pipeline (ledger → Oracle → report → exit status), not the strategy.

## What this does not show

- **The Ambiguous commit.** `pg_terminate_backend` rolls back or fails fast; across 274 kills no Confirm committed and then lost its response. That case (COMMIT sent, link drops) needs C2's network Fault (Toxiproxy reset/latency) or app SIGKILL; the retry Oracles are ready for it.
- Hold creation's own retry (`POST /holds` idempotency key re-sent after a Fault) is covered only indirectly (fresh-hold races in hold-expiry, judged by Oracles 1 and 4); there is no ledger of fresh-hold keys, so no "exactly one Hold per key" Oracle yet.
- Small concurrency (12 seats / 40–100 holds) by the `somaxconn` ceiling; many repeats instead. Only `pessimistic` (ADR-0017); Postgres restart is C4.

## Reproducing

```bash
docker compose up -d                          # Postgres on :5433
npm run chaos:holds -- --mode hold-expiry --survive-uncaught --kill-fraction 0.3
npm run chaos:holds -- --mode hold-expiry --reaper-stall-seats 3 --survive-uncaught --kill-fraction 0.3
npm run chaos:holds -- --mode hold-confirm --concurrency 100 --attempts-per-hold 1 --survive-uncaught --kill-interval-ms 10
npm run chaos:holds -- --mode hold-expiry                  # unmodified (crashes: R1)
npm run chaos:holds -- --mode hold-expiry --fault none --sabotage late-confirm --expect-violations
npx vitest run test/chaos
```
