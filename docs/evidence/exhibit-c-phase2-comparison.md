# Exhibit C — Phase 2 mechanism comparison

Phase 2 deliverable (todo.md, issue #18): the full concurrency-control
mechanism comparison — all six strategies (`naive` retained as the
continuing baseline, plus `unique_constraint`, `pessimistic`, `optimistic`,
`advisory`, `serializable`) benchmarked against each other across both load
patterns, not just against the pass/fail gate individually.

## Method

Same harness as Exhibits A/B (`load-harness/run.ts` +
`load-harness/hammer-seat.k6.js`), plus the spread-across-seats pattern
added in issue #17 (`load-harness/spread-across-seats.k6.js`). Matrix:
all-same-seat at concurrency {10, 100, 1,000}; spread-across-seats at
{1,000} only; each cell run once, except the 1,000-concurrent/all-same-seat
cell for `optimistic`, `advisory`, and `serializable`, run twice
independently (issue #18's acceptance criterion). `BOOKING_STRATEGY` is
fixed per server process (ADR-0002), so the matrix is driven by restarting
the server between mechanisms — this harness deliberately does not add
server-lifecycle orchestration (issue #18's scope note).

```bash
BOOKING_STRATEGY=<mechanism> PORT=3000 npm run start
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern hammer-seat   --concurrency 10   --repeat 1
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern hammer-seat   --concurrency 100  --repeat 1
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern hammer-seat   --concurrency 1000 --repeat <1 or 2>
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern spread-seats  --concurrency 1000 --repeat 1

npm run harness:aggregate   # this script — reads docs/evidence/*.json, writes this file
```

## Results

| Mechanism | Pattern | Concurrency | Repeats | Requests | Throughput (req/s) | p50 (ms) | p99 (ms) | Conflict rate | Retry-exhaustion rate | Double-booked? | Report |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `naive` | hammer-seat | 10 | 1 | 10 | 318.9 | 25.5 | 25.7 | 90.0% | 0.0% | no | [naive-load-run-2026-08-23T08-08-51-362Z.json](naive-load-run-2026-08-23T08-08-51-362Z.json) |
| `naive` | hammer-seat | 100 | 1 | 100 | 1364.1 | 60.4 | 67.8 | 99.0% | 0.0% | no | [naive-load-run-2026-08-23T08-08-52-142Z.json](naive-load-run-2026-08-23T08-08-52-142Z.json) |
| `naive` | hammer-seat | 1000 | 1 | 1000 | 4218.0 | 12.6 | 38.7 | 99.9% | 0.0% | no | [naive-load-run-2026-08-23T08-08-52-895Z.json](naive-load-run-2026-08-23T08-08-52-895Z.json) |
| `naive` | spread-seats | 1000 | 1 | 1000 | 2588.8 | 51.1 | 140.7 | 0.0% | 0.0% | no | [naive-spread-seats-load-run-2026-08-23T08-08-53-858Z.json](naive-spread-seats-load-run-2026-08-23T08-08-53-858Z.json) |
| `unique_constraint` | hammer-seat | 10 | 1 | 10 | 345.4 | 27.0 | 27.3 | 90.0% | 0.0% | no | [unique_constraint-load-run-2026-08-23T08-08-56-626Z.json](unique_constraint-load-run-2026-08-23T08-08-56-626Z.json) |
| `unique_constraint` | hammer-seat | 100 | 1 | 100 | 1594.0 | 51.2 | 59.4 | 99.0% | 0.0% | no | [unique_constraint-load-run-2026-08-23T08-08-57-294Z.json](unique_constraint-load-run-2026-08-23T08-08-57-294Z.json) |
| `unique_constraint` | hammer-seat | 1000 | 1 | 1000 | 3761.4 | 44.8 | 128.4 | 99.9% | 0.0% | no | [unique_constraint-load-run-2026-08-23T08-08-58-026Z.json](unique_constraint-load-run-2026-08-23T08-08-58-026Z.json) |
| `unique_constraint` | spread-seats | 1000 | 1 | 1000 | 3746.6 | 95.4 | 128.4 | 0.0% | 0.0% | no | [unique_constraint-spread-seats-load-run-2026-08-23T08-08-59-048Z.json](unique_constraint-spread-seats-load-run-2026-08-23T08-08-59-048Z.json) |
| `pessimistic` | hammer-seat | 10 | 1 | 10 | 431.1 | 18.5 | 21.5 | 90.0% | 0.0% | no | [pessimistic-load-run-2026-08-23T08-09-01-709Z.json](pessimistic-load-run-2026-08-23T08-09-01-709Z.json) |
| `pessimistic` | hammer-seat | 100 | 1 | 100 | 1863.4 | 30.3 | 49.9 | 99.0% | 0.0% | no | [pessimistic-load-run-2026-08-23T08-09-02-414Z.json](pessimistic-load-run-2026-08-23T08-09-02-414Z.json) |
| `pessimistic` | hammer-seat | 1000 | 1 | 1000 | 5685.1 | 54.0 | 105.3 | 99.9% | 0.0% | no | [pessimistic-load-run-2026-08-23T08-09-03-129Z.json](pessimistic-load-run-2026-08-23T08-09-03-129Z.json) |
| `pessimistic` | spread-seats | 1000 | 1 | 1000 | 3722.8 | 96.7 | 168.0 | 0.0% | 0.0% | no | [pessimistic-spread-seats-load-run-2026-08-23T08-09-04-018Z.json](pessimistic-spread-seats-load-run-2026-08-23T08-09-04-018Z.json) |
| `optimistic` | hammer-seat | 10 | 1 | 10 | 339.5 | 25.3 | 27.8 | 90.0% | 0.0% | no | [optimistic-load-run-2026-08-23T08-09-06-675Z.json](optimistic-load-run-2026-08-23T08-09-06-675Z.json) |
| `optimistic` | hammer-seat | 100 | 1 | 100 | 1759.8 | 48.5 | 54.3 | 99.0% | 0.0% | no | [optimistic-load-run-2026-08-23T08-09-07-376Z.json](optimistic-load-run-2026-08-23T08-09-07-376Z.json) |
| `optimistic` | hammer-seat | 1000 | 2 | 2000 | 3331.7 | 64.0 | 119.0 | 99.9% | 0.0% | no | [optimistic-load-run-2026-08-23T08-09-08-105Z.json](optimistic-load-run-2026-08-23T08-09-08-105Z.json) |
| `optimistic` | spread-seats | 1000 | 1 | 1000 | 2750.9 | 51.2 | 90.5 | 0.0% | 0.0% | no | [optimistic-spread-seats-load-run-2026-08-23T08-09-09-925Z.json](optimistic-spread-seats-load-run-2026-08-23T08-09-09-925Z.json) |
| `advisory` | hammer-seat | 10 | 1 | 10 | 377.8 | 22.2 | 24.7 | 90.0% | 0.0% | no | [advisory-load-run-2026-08-23T08-09-12-709Z.json](advisory-load-run-2026-08-23T08-09-12-709Z.json) |
| `advisory` | hammer-seat | 100 | 1 | 100 | 2134.2 | 34.3 | 43.7 | 99.0% | 0.0% | no | [advisory-load-run-2026-08-23T08-09-13-408Z.json](advisory-load-run-2026-08-23T08-09-13-408Z.json) |
| `advisory` | hammer-seat | 1000 | 2 | 2000 | 5670.3 | 48.3 | 79.3 | 99.9% | 0.0% | no | [advisory-load-run-2026-08-23T08-09-14-120Z.json](advisory-load-run-2026-08-23T08-09-14-120Z.json) |
| `advisory` | spread-seats | 1000 | 1 | 1000 | 1642.6 | 55.7 | 140.7 | 0.0% | 0.0% | no | [advisory-spread-seats-load-run-2026-08-23T08-09-15-608Z.json](advisory-spread-seats-load-run-2026-08-23T08-09-15-608Z.json) |
| `serializable` | hammer-seat | 10 | 1 | 10 | 380.9 | 24.3 | 24.7 | 90.0% | 0.0% | no | [serializable-load-run-2026-08-23T08-09-18-620Z.json](serializable-load-run-2026-08-23T08-09-18-620Z.json) |
| `serializable` | hammer-seat | 100 | 1 | 100 | 1745.6 | 51.4 | 53.3 | 99.0% | 0.0% | no | [serializable-load-run-2026-08-23T08-09-19-326Z.json](serializable-load-run-2026-08-23T08-09-19-326Z.json) |
| `serializable` | hammer-seat | 1000 | 2 | 2000 | 4891.9 | 45.0 | 81.3 | 99.9% | 0.0% | no | [serializable-load-run-2026-08-23T08-09-20-053Z.json](serializable-load-run-2026-08-23T08-09-20-053Z.json) |
| `serializable` | spread-seats | 1000 | 1 | 1000 | 3031.6 | 171.6 | 258.5 | 0.0% | 0.0% | no | [serializable-spread-seats-load-run-2026-08-23T08-09-21-604Z.json](serializable-spread-seats-load-run-2026-08-23T08-09-21-604Z.json) |


## Two-independent-repeats gate (`optimistic`, `advisory`, `serializable`)

Their retry policies (ADR-0009 optimistic compare-and-swap, ADR-0011
serializable's dedicated transaction helper, both capable of exhausting
retries per ADR-0012) make "exactly one winner" less obviously guaranteed a
priori than a plain lock or constraint, hence the extra repeat — the same
bar Phase 1 already cleared for `unique_constraint`/`pessimistic` (Exhibit
B) at 1,000-concurrent/all-same-seat.

| Mechanism | Repeats observed | Zero double-bookings across ≥2 repeats |
|---|---|---|
| `optimistic` | 2 | **PASS** |
| `advisory` | 2 | **PASS** |
| `serializable` | 2 | **PASS** |


## Reading the columns

- **Throughput / p50 / p99**: mean across repeats within each cell, from
  k6's `http_reqs` rate and `http_req_duration` trend stats
  (`--summary-export`), not derived from the harness's own wall-clock
  timing.
- **Conflict rate**: HTTP 409 responses (`conflict`) over total requests in
  the cell.
- **Retry-exhaustion rate**: HTTP 503 responses (`retry_exhausted`,
  ADR-0012) over total requests — reported as its own column rather than
  folded into a generic failure tally, per ADR-0012's stated consequence.
  `0.0%` for every mechanism at every concurrency level is itself a
  finding: `optimistic` and `serializable` — the two mechanisms whose
  retry budgets can actually be exhausted (ADR-0012) — never hit that
  budget within this matrix's load levels. `advisory` blocks on the lock
  rather than retrying, and `naive`/`unique_constraint`/`pessimistic`
  never retry at all, so `0.0%` is definitional for all four.
- **Double-booked?**: ground truth from `booking_seats`, not from HTTP
  status codes (see `run.ts`'s `runOnce`/`runSpreadSeatsOnce`) — the
  single hard pass/fail gate (PRD §Metrics & Acceptance Criteria).

## Next step

Phase 3+ (todo.md): multi-seat transactions and deadlock-ordering
correctness, building on this phase's per-mechanism overhead baseline
(spread-across-seats, issue #17) to distinguish genuine multi-seat
contention cost from single-mechanism overhead.
