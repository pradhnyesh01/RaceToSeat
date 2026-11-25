# Chaos C1 (tracer): backend-kill against `pessimistic`, measured on unmodified code

Issue #44, under umbrella #42. This is the C1 findings record — the raw first-run result, kept as found. It is **not** Exhibit H (that is C5, #52, which will fold this in alongside C2–C4). Definitions (Fault, Ambiguous outcome, Oracle, Correctness violation, Robustness finding) are in `CONTEXT.md`; the reasoning is in ADR-0022 (what "correct under chaos" means) and ADR-0023 (negative controls without production toggles).

Raw per-run reports and app logs are in `docs/evidence/chaos/` (one `.json` + `.app.log` per run).

## Headline

| | |
|---|---|
| Correctness violations (any Oracle failing on `pessimistic`) | **0** across every backend-kill run, unmodified and scaffolded |
| Robustness findings | **4** (R1–R4 below), all confirming the pre-run hypotheses in CLAUDE.md — with one correction to hypothesis 1's expected fix |
| Negative controls | Oracle 1 flags `naive`'s double-booking on a scratch DB without `UNIQUE(seat_id)` in **3/3** runs; the same run on the real schema is clean; 28 hand-corrupted-state unit tests pass and 20 of them fail if the Oracles are neutered |
| Production code changed | None: `src/` and `db/schema.sql` are untouched in this ticket |

**Read the first number with its caveat.** On unmodified code the app dies on the first killed connection (R1), so those runs judge almost nothing — only 1–10 of each run's 120 requests were ever answered (1 of 300 in the very first run). Their "all four Oracles pass" is honest but weak. The meaningful correctness evidence is the scaffolded runs (`--survive-uncaught`, ADR-0022), where 59 mid-transaction kills across 6 runs left every Oracle intact. The two kinds of run are reported separately and never merged.

## Method

- **Load**: the existing `deadlock-pairs.k6.js`, unmodified — 60 disjoint 2-seat pairs, both orderings fired at once (120 requests). Chosen over single-seat patterns because multi-seat Bookings give Oracle 2 (atomicity) something to detect. 60 is the ceiling for a clean baseline on this machine: macOS `kern.ipc.somaxconn` is 128, and at ≥80 pairs the load generator alone produces connection resets with no Fault at all (observed; ≤60 pairs is clean).
- **App under test**: `tsx src/server.ts` as a child process, `BOOKING_STRATEGY=pessimistic`, its `DATABASE_URL` pointed at the Toxiproxy listener (`:5434` → `postgres:5432`, compose profile `chaos`). The harness's own driver/Oracle connections go straight to Postgres on `:5433`.
- **Fault**: `pg_terminate_backend` against the app's backends that are in a transaction (`xact_start IS NOT NULL` — active mid-statement or idle-in-transaction), swept every 40 ms, each eligible backend killed with probability 0.5 (0.3 for the scaffolded runs). The harness's own connections are exempt by `application_name`.
- **Recovery**: after the load drains and the Fault stops, the app is restarted if it crashed (a stand-in for a process supervisor — the crash stays on record), every Idempotency Key is re-sent, then the four Oracles run against stored state.

## First run, as found (unmodified production code)

Run `first-run-backend-kill` (150 pairs; later superseded by the clean-baseline reruns below, which agree):

- **The app process died on the first kill.** Exit code 1, 1 backend terminated (state `active`), 299 of 300 requests got no HTTP answer (connection reset / EOF), 1 got a `500`.
- Log: `error: terminating connection due to administrator command` (the in-flight request's own error, returned as that `500`), then `throw er; // Unhandled 'error' event ... Error: Connection terminated unexpectedly ... Emitted 'error' event on Client instance`.
- Oracles 1–4: all PASS (after restart + full key replay: 150 × 201, 150 × 409).

Reruns at the clean-baseline concurrency (`unmodified-kill-rep1..3`, 60 pairs): all three crashed on the first-to-third kill (18/2/5 backends terminated before the load ended), 119/114/110 of 120 requests unanswered, all four Oracles PASS each time. Crash reproduced **4 of 4** unmodified backend-kill runs.

`unmodified-idle-pool-kill`: the load ran to completion cleanly (60 × 201, 60 × 409), *then* every idle pooled connection was killed in one sweep (120 backends). The app crashed with `Emitted 'error' event on BoundPool instance`, with no request in flight.

## The three CLAUDE.md hypotheses

All three hold. One needs a correction to the *expected fix*.

### 1. No `pool.on("error")` handler → process crash on a killed connection — **HOLDS** (Robustness finding)

Confirmed on two distinct paths, both fatal:

- **R1 — a checked-out client, in a transaction.** A kill while a request owns the connection emits `'error'` on the `Client`, which has no listener → uncaught → exit 1. This is the common case under load (4/4 runs).
- **R2 — an idle pooled client.** A kill of a connection sitting in the pool emits `'error'` on the `BoundPool`, which has no listener → uncaught → exit 1 (`unmodified-idle-pool-kill`, 1/1).

**Correction to the hypothesis's implied fix.** CLAUDE.md names a missing `pool.on("error")`. That handler would cover R2 only. pg-pool deliberately *removes* its own per-client error listener when a client is checked out (`node_modules/pg-pool/index.js:344`, `client.removeListener('error', idleListener)`; re-added on release at `:385`), so R1 — the dominant path — is not routed through the pool at all and needs a per-checkout `client.on('error')`. A fix ticket that adds only `pool.on("error")` would leave R1 crashing. (Verified by reading pg-pool 3.14.0 and by the observed `Emitted 'error' event on Client instance` log; not by trying the fix, which is out of scope here.)

### 2. No statement / lock / idle-in-transaction timeouts — **HOLDS** in configuration; consequence not yet exercised (R4)

- `grep` over `src/` and `db/` finds no `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `connectionTimeoutMillis`, `query_timeout`, or `idleTimeoutMillis`; `pool.ts` constructs `new Pool({ connectionString, max })` only.
- Server side, every run records `pg_settings`: `statement_timeout=0`, `lock_timeout=0`, `idle_in_transaction_session_timeout=0`, `idle_session_timeout=0` (all disabled), `tcp_keepalives_idle=7200`.
- **Not demonstrated**: the harmful *behavior* (a request hanging indefinitely on a stalled connection, or a transaction leaking its row locks). A backend kill fails fast — the peer vanishes and every statement errors immediately — so it cannot produce a stall; no recorded run had a request slower than 139 ms. That needs a Fault that silences rather than severs the connection (Toxiproxy partition/`timeout` toxic, ticket C2). R4 is therefore filed as *configuration confirmed, impact pending C2*.

### 3. `withTransaction`'s catch-block `ROLLBACK` masks the original error — **HOLDS** (R3, Robustness finding)

Six scaffolded runs produced 53 HTTP `500`s. The logged error's top frame is `withTransaction`'s catch-block `ROLLBACK` (`src/db/pool.ts:47`) in **50 of 53** (32 as `Client has encountered a connection error and is not queryable`, 18 as `Connection terminated unexpectedly`); the other 3 failed earlier (1 at `BEGIN`, `pool.ts:41`; 2 before any transaction opened). In those 50 the statement that actually failed — the real root cause — is discarded when the `ROLLBACK` on the dead connection throws a different error from the catch block. Every client sees a bare `500` either way, and an operator's logs name the wrong error. It affects diagnosability only; no Oracle was affected.

## Scaffolded runs: where the Oracles actually get exercised

`--survive-uncaught` preloads an `uncaughtException` handler into the app (harness scaffolding, ADR-0022; `src/` unchanged; every swallowed exception counted). Six runs, 60 pairs each:

| run | kills | 201 / 409 / 500 | uncaught exceptions swallowed | Oracles 1-4 |
|---|---:|---|---:|---|
| survive-kill-rep1 | 14 | 59 / 50 / 11 | 14 | PASS ×4 |
| rep2 | 9 | 59 / 52 / 9 | 9 | PASS ×4 |
| rep3 | 11 | 59 / 52 / 9 | 11 | PASS ×4 |
| rep4 | 9 | 57 / 54 / 9 | 9 | PASS ×4 |
| rep5 | 2 | 60 / 58 / 2 | 2 | PASS ×4 |
| rep6 | 14 | 56 / 51 / 13 | 14 | PASS ×4 |

59 kills → 59 would-be process crashes (R1) → 53 requests answered `500`. Replay after every run returned 60 × `201` (every pair ends with exactly one Booking) and 60 × `409`. Zero double-booking, zero torn Bookings, zero duplicate Bookings per key, zero stuck or locked seats.

## Classification

| id | finding | class | evidence |
|---|---|---|---|
| R1 | Process exits on a killed *checked-out* connection (unhandled `Client` `'error'`); `pool.on("error")` alone would not fix it | Robustness | 4/4 unmodified backend-kill runs |
| R2 | Process exits on a killed *idle pooled* connection (unhandled `BoundPool` `'error'`) | Robustness | `unmodified-idle-pool-kill` |
| R3 | `withTransaction`'s `ROLLBACK` throws over the original error on a dead connection; infra failure surfaces as an unclassified `500` (not a designed outcome: only 201/409/404/503 are) | Robustness | 50/53 logged errors, `pool.ts:47` |
| R4 | No statement/lock/idle-in-transaction/pool-acquire timeouts anywhere; impact (hung requests, leaked locks) unmeasured | Robustness (config confirmed, impact pending C2) | grep + `pg_settings` |

**Correctness violations: none.** Each Robustness finding becomes its own ticket under C5 (#52); none is fixed here, per the measure-first policy.

## Negative controls

1. **Unit controls** — `test/chaos/oracles.test.ts` (28 tests) runs each Oracle against hand-corrupted states in a scratch database: double-booked seat, doubly-held seat, booking+hold on one seat, claim vs `seats.status` disagreement, wrong `booked_by`, a multi-seat Booking missing a seat / with none / with an extra, a `booked` seat with no Booking, a duplicated / replaced / vanished / re-seated key, a held seat with no Hold, an expired-never-reaped hold, and a genuinely leaked row lock — each with a clean-state twin. Mutation check: neutering the Oracles' verdict makes 20 of 28 fail (the 8 that still pass are the clean twins). `test/chaos/faults.test.ts` (5 tests) pins the Fault driver's own contract (kills what it says, never the harness's own connections).
2. **End-to-end control** — `naive` against a scratch database = `db/schema.sql` minus `booking_seats`/`hold_seats` `UNIQUE(seat_id)`, hammering one seat with 60 concurrent requests, run with `--expect-violations`:

| run | winners the Oracle found on one seat | Oracle 1 |
|---|---:|---|
| negctl-naive-scratch-rep1 | 13 | FAIL (flagged) |
| negctl-naive-scratch-rep2 | 7 | FAIL (flagged) |
| negctl-naive-scratch-rep3 | 8 | FAIL (flagged) |
| negctl-naive-shared-schema (real schema, the control's control) | 1 | PASS |

Oracles 2–4 correctly stayed green in all four runs (the corruption is a mutual-exclusion violation only). Without `--expect-violations` the scratch run exits 1; with it, exits 0 only because the Oracles flagged something.

## Not covered here (explicitly)

Network Faults (latency, partition-and-heal), app `SIGKILL`, and the other five mechanisms are C2 (#49); hold/confirm/reaper under Fault is C3 (#50), so Oracle 4's expiry branch is unit-tested here but not yet exercised by a run; Postgres restart is C4 (#51). Only one load shape (`deadlock-pairs`) was run under Fault in this ticket, although the harness also supports `hammer-seat` and `spread-seats`.

## Reproducing

```bash
docker compose up -d                          # Postgres on :5433 (unchanged default)
docker compose --profile chaos up -d          # + Toxiproxy on :5434 (opt-in)
npm run chaos                                 # first run: unmodified backend-kill vs pessimistic
npm run chaos -- --fault idle-pool-kill       # hypothesis 1, idle-connection path
npm run chaos -- --survive-uncaught --kill-fraction 0.3
npm run chaos -- --strategy naive --load hammer-seat --db scratch-no-unique --fault none --expect-violations
```
