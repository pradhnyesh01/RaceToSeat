# Exhibit E — Phase 4 cross-seat isolation benchmark (NFR2)

Phase 4 deliverable (todo.md, issue #35): measured evidence for NFR2 — does
sustained high-concurrency contention on one "hot" seat degrade p99 latency
for requests against unrelated seats by more than the agreed 10% threshold
(PRD.md)? Builds on issue #33's foundation: the `isolation` load pattern
(`load-harness/cross-seat-isolation.k6.js`, hot-seat burst + background
stream as two concurrent k6 scenarios in one invocation) and the widened
connection configuration (Postgres `max_connections` 100→600, app pool
`PG_POOL_MAX` 50→500, `docker-compose.yml`/`src/db/pool.ts`) that keeps
connection-pool admission from dominating the isolation signal at this
pattern's 1,000+1,000-request peak concurrency.

## Method

For each of the six `BOOKING_STRATEGY` mechanisms, at the widened
connection configuration: the background-only baseline and the combined
(hot + background) variant, each run twice (`--repeat 2`, one harness
invocation per variant — the harness resets via `DELETE /bookings/{id}`
between repeats and writes both repeats into one report). Each side's
background-stream p99 is averaged across its two repeats before computing
one degradation percentage per mechanism: `(combined p99 − baseline p99) /
baseline p99`.

```bash
docker compose up -d   # max_connections=600 (issue #33)
npm run db:migrate
BOOKING_STRATEGY=<mechanism> PORT=3000 npm run start
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern isolation --background-only --concurrency 1000 --repeat 2
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern isolation                    --concurrency 1000 --repeat 2

npm run harness:aggregate -- --exhibit e   # this script — reads docs/evidence/*.json, writes this file
```

**`pessimistic` and `optimistic`'s exception (5 repeats, not 2):** the
original 2-repeat measurement reported +37.5% for `pessimistic` and +14.4%
for `optimistic` (both FAIL). A same-session follow-up grilling pass found
`pessimistic`'s didn't reproduce — three independent single-repeat reruns
swung from -41% to +4%, including negative-degradation runs, with baseline
p99 alone varying 174-482ms with zero hot-seat contention at all — clear
2-repeat noise, not a stable signal. `optimistic`'s did reproduce (all
positive, several far larger than +14.4%) and was carried into issue #36's
investigation. Both were re-measured at `--repeat 5` for both variants and
Exhibit E regenerated, which is why their rows below show 5/5 repeats where
the other four mechanisms show 2/2.

**Negative control:** to confirm the measurement can actually detect a
violation before reporting six results all expected to pass, `pessimistic`
— the one mechanism whose lock acquisition genuinely blocks
(`SELECT ... FOR UPDATE NOWAIT` still queues connection admission itself
under an undersized pool, ADR-0006) — was also run once under the project's
*prior* connection configuration:

```bash
docker stop racetoseat-postgres && docker rm racetoseat-postgres
docker run -d --name racetoseat-postgres -p 5433:5432 \
  -e POSTGRES_USER=racetoseat -e POSTGRES_PASSWORD=racetoseat -e POSTGRES_DB=racetoseat \
  -v racetoseat_racetoseat-pgdata:/var/lib/postgresql/data \
  postgres:17 postgres -c deadlock_timeout=100ms -c max_connections=100
BOOKING_STRATEGY=pessimistic PG_POOL_MAX=50 PORT=3000 npm run start
BOOKING_STRATEGY=pessimistic npm run harness -- --pattern isolation --concurrency 1000 --repeat 1
# output file renamed to insert "negative-control" so aggregate.ts excludes
# it from the per-strategy matrix dedup above
docker compose up -d   # restores max_connections=600
```

## Results — widened connection configuration (all six mechanisms)

| Mechanism | Repeats (baseline/combined) | Baseline p99 (ms) | Combined p99 (ms) | Degradation | Pass (<10%)? | Baseline bg throughput (req/s) | Combined bg throughput (req/s) | Double-booked? | Reports |
|---|---|---|---|---|---|---|---|---|---|
| `naive` | 2/2 | 595.8 | 218.0 | -63.4% | **PASS** | 2308.2 | 327.1 | no | [naive-isolation-baseline-load-run-2026-08-24T16-46-18-421Z.json](naive-isolation-baseline-load-run-2026-08-24T16-46-18-421Z.json), [naive-isolation-load-run-2026-08-24T16-46-21-551Z.json](naive-isolation-load-run-2026-08-24T16-46-21-551Z.json) |
| `unique_constraint` | 2/2 | 282.4 | 228.5 | -19.1% | **PASS** | 2784.6 | 517.5 | no | [unique_constraint-isolation-baseline-load-run-2026-08-24T16-46-33-067Z.json](unique_constraint-isolation-baseline-load-run-2026-08-24T16-46-33-067Z.json), [unique_constraint-isolation-load-run-2026-08-24T16-46-35-895Z.json](unique_constraint-isolation-load-run-2026-08-24T16-46-35-895Z.json) |
| `pessimistic` | 5/5 | 189.0 | 163.3 | -13.6% | **PASS** | 2907.0 | 517.6 | no | [pessimistic-isolation-baseline-load-run-2026-08-24T17-04-41-616Z.json](pessimistic-isolation-baseline-load-run-2026-08-24T17-04-41-616Z.json), [pessimistic-isolation-load-run-2026-08-24T17-04-48-608Z.json](pessimistic-isolation-load-run-2026-08-24T17-04-48-608Z.json) |
| `optimistic` | 5/5 | 234.2 | 374.9 | +60.1% | **FAIL** | 2733.4 | 1043.0 | no | [optimistic-isolation-baseline-load-run-2026-08-24T17-14-52-243Z.json](optimistic-isolation-baseline-load-run-2026-08-24T17-14-52-243Z.json), [optimistic-isolation-load-run-2026-08-24T17-14-59-192Z.json](optimistic-isolation-load-run-2026-08-24T17-14-59-192Z.json) |
| `advisory` | 2/2 | 272.2 | 266.5 | -2.1% | **PASS** | 1052.6 | 540.3 | no | [advisory-isolation-baseline-load-run-2026-08-24T16-47-18-132Z.json](advisory-isolation-baseline-load-run-2026-08-24T16-47-18-132Z.json), [advisory-isolation-load-run-2026-08-24T16-47-22-341Z.json](advisory-isolation-load-run-2026-08-24T16-47-22-341Z.json) |
| `serializable` | 2/2 | 444.4 | 286.5 | -35.5% | **PASS** | 2013.8 | 1256.3 | no | [serializable-isolation-baseline-load-run-2026-08-24T16-47-32-748Z.json](serializable-isolation-baseline-load-run-2026-08-24T16-47-32-748Z.json), [serializable-isolation-load-run-2026-08-24T16-47-36-584Z.json](serializable-isolation-load-run-2026-08-24T16-47-36-584Z.json) |


## Results — negative control (prior connection configuration)

Representative mechanism: `pessimistic`. Its combined isolation variant was run once (`--repeat 1`) against a Postgres reconfigured to the project's prior `max_connections=100` with the app pool's prior `PG_POOL_MAX=50` (both since raised to 600/500, issue #33), rather than a fresh un-widened baseline — the reference point below is `pessimistic`'s own widened-configuration baseline from the matrix above, which approximates the no-pool-contention case closely enough to demonstrate the harness can detect a real violation.

| | Background p99 (ms) | Background throughput (req/s) | Degradation vs. widened-config baseline | Pass (<10%)? |
|---|---|---|---|---|
| Negative control (`max_connections=100`, `PG_POOL_MAX=50`) | 897.4 | 856.0 | +374.7% | **FAIL** |
| pessimistic widened-config baseline (reference) | 189.0 | — | — | — |

Full report: [pessimistic-isolation-negative-control-load-run-2026-08-24T16-48-28-650Z.json](pessimistic-isolation-negative-control-load-run-2026-08-24T16-48-28-650Z.json).


## Results — pool-scaling test (`optimistic`, issue #36)

Representative mechanism: `optimistic`, re-run at `PG_POOL_MAX=1000` (Postgres temporarily reconfigured to `max_connections=1200` to give that pool real headroom, restored to 600 afterward) — a scoped confirmatory test, hence 3 repeats rather than the 5+ used for a trustworthy magnitude elsewhere in this exhibit.

| | Repeats | Baseline p99 (ms) | Combined p99 (ms) | Degradation |
|---|---|---|---|---|
| Default pool (`PG_POOL_MAX=500`) | 5/5 | 234.2 | 374.9 | +60.1% |
| Scaled pool (`PG_POOL_MAX=1000`) | 3/3 | 394.3 | 600.6 | +52.3% |

2x the pool headroom only modestly reduced the degradation (+60.1% → +52.3%), not the substantial drop a pool-spillover-dominated cause would predict — evidence *against* connection-pool queuing as the primary driver, and *for* the genuine extra per-request Postgres work identified below.

Full reports: [optimistic-isolation-pool-scaling-baseline-load-run-2026-08-24T17-15-57-108Z.json](optimistic-isolation-pool-scaling-baseline-load-run-2026-08-24T17-15-57-108Z.json), [optimistic-isolation-pool-scaling-load-run-2026-08-24T17-16-04-631Z.json](optimistic-isolation-pool-scaling-load-run-2026-08-24T17-16-04-631Z.json).


## Findings

`optimistic` exceed(s) the 10% degradation threshold at the widened connection configuration. Per this project's single hard correctness gate (PRD §Metrics & Acceptance Criteria: zero double-booking), this is **not** a blocker for this exhibit's completion — NFR2 is a measured non-functional target, not the correctness gate.

### `optimistic` (issue #36 investigation, this exhibit's numbers below are always current)

Current magnitude at 5 repeats: `+60.1%`
— substantially larger than the original 2-repeat +14.4%, and (unlike
`pessimistic`'s) a real, reproducible signal: three independent
single-repeat reruns during the follow-up investigation were all positive
(up to +573%).

**Root cause, confirmed empirically:** a losing request under hot-seat
contention takes a more expensive path in `optimistic` than in the other
five mechanisms. Comparing Postgres query-log volume for the identical
50-concurrent single-seat burst: `naive` issued 169 total statements,
`optimistic` issued 405 — **~2.4x**. This matches the code path exactly:
an ordinary CAS miss (the seat is already `'booked'`, not a concurrent-
cancellation race) runs an initial `readSeats`, a `SAVEPOINT`, the CAS
`UPDATE` itself (a real row check even though it affects 0 rows), a
`ROLLBACK TO SAVEPOINT`, and a second `readSeats` (ADR-0009's
cancellation-race check) — roughly double `naive`'s single read-then-write
path, before accounting for connection-pool round-trip overhead on top.

**Pool-scaling test rules out pool spillover as the primary cause** (see
above): doubling `PG_POOL_MAX` only modestly reduced the degradation. The
cost is genuine extra Postgres-side work from the CAS-miss path's shape, not
connections queuing for a slot.

**Recommendation: document as an inherent trade-off, not fix.** The second
`readSeats` isn't incidental overhead — it's ADR-0009's correctness
mechanism for distinguishing a genuine conflict from a concurrent
cancellation race (see `optimistic.test.ts`'s "retries and succeeds when a
CAS miss turns out to be a concurrent cancellation" test). Removing it to
cut round-trips would weaken that guarantee; a real fix would need a
different query shape entirely (e.g. a single `UPDATE ... RETURNING`
combining the CAS and the conflict-vs-cancellation check), which changes
what Exhibit C's own comparative benchmark is measuring for this mechanism —
out of scope for an isolation-measurement ticket. `optimistic`'s extra
cost under hot-seat contention is a property of the CAS-retry design this
project set out to compare against pessimistic/advisory locking, not a bug
in it.

Under a slow link the same design shows up as latency, not retries (issue
#59, finding R6, ADR-0028): with 100 ms added per protocol chunk, 48 of 60
hot-seat requests waited on the winner's row lock past the 1.5 s statement
bound and were answered `504`, while `naive` finished all 60 in 1.2 s. Every
`optimistic` response in that run carried `X-Booking-Retries: 0` — the CAS
retry loop never ran — so this is queueing behind the winner, not retry
amplification, and a time budget on the loop would not change it. Accepted
as part of this mechanism's trade-off (Exhibit H, section J).

The negative control demonstrates the measurement is sensitive enough to
catch a real violation: run against the project's prior, un-widened
connection configuration, the same pattern that (mostly) passes above
produces a measurably larger degradation, consistent with connection-pool
queuing rather than row-lock contention (the caveat already noted inline in
`cross-seat-isolation.k6.js` since issue #33) — the same phenomenon the
pool-scaling test above found does *not* explain `optimistic`'s own
degradation, a useful contrast: two different mechanisms can each show a
real NFR2 finding for two different underlying reasons.

## Reading the columns

- **Repeats (baseline/combined)**: how many independent repeats each side's
  mean is drawn from — 2/2 for four mechanisms, 5/5 for `pessimistic` and
  `optimistic` (see Method's exception note above).
- **Baseline / Combined p99**: mean across that many repeats of the
  *background stream's* `http_req_duration` p99 (k6 `--summary-export`) —
  baseline is the background-only run (no hot-seat contention), combined is
  the same background stream measured while the hot-seat burst runs
  concurrently. The hot stream's own latency isn't what NFR2 asks about and
  isn't in this table.
- **Degradation**: `(combined p99 − baseline p99) / baseline p99`, computed
  once per mechanism from the two already-averaged p99s above, not averaged
  per-repeat.
- **Pass (<10%)?**: NFR2's stated threshold (PRD.md).
- **Baseline / Combined bg throughput**: mean across the same repeats of the
  background stream's `http_reqs` rate.
- **Double-booked?**: ground truth from `booking_seats` (see `run.ts`'s
  `runIsolationOnce`) — the single hard pass/fail gate, unaffected by
  whatever NFR2 shows.

## Next step

Both of Exhibit E's original findings are resolved. `pessimistic`'s didn't
survive re-measurement and needed no ticket (corrected above, same session).
`optimistic`'s did reproduce and was root-caused in
[issue #36](https://github.com/pradhnyesh01/RaceToSeat/issues/36): documented
above as an inherent trade-off of the CAS-retry design, not fixed — no
further follow-up ticket from this exhibit. Phase 4 (todo.md) is complete.
