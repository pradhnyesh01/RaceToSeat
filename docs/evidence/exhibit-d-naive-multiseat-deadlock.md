# Exhibit D — naive's multi-seat path deadlocks, then doesn't

Phase 3 deliverable (todo.md, issue #26): real, measured evidence that
`naive`'s unordered multi-seat extension (issue #24) genuinely deadlocks
under adversarial load, then the fix — consistent seat-id ordering plus
`withDeadlockRetry` (ADR-0014) as a fallback layer — re-measured to confirm
zero. Mirrors Exhibit A's precedent (problem-statement.md: "correctness must
be demonstrated, not assumed"): the "before" state below is the real,
already-committed code from issue #24, not something deliberately re-broken
for this ticket.

## Method

`load-harness/run.ts --pattern deadlock-pairs` (issue #25) seeds N disjoint
2-seat pairs and fires both orderings of each pair concurrently — for pair
`[A, B]`, one request books `seat_ids: [A, B]`, another simultaneously books
`seat_ids: [B, A]`. Deadlock rate reads off the existing
`X-Booking-Retries`/`retry_exhausted` (503) signal; a deadlock that isn't
caught by any retry logic surfaces as an unhandled Postgres error instead,
which Fastify turns into a bare 500 — tallied by the harness as `other`.
Test/dev Postgres `deadlock_timeout` is 100ms (issue #25), not the 1s
default, so a genuine deadlock's detect-and-abort cycle stays well inside
NFR3's p99 < 1s budget.

```bash
docker compose up -d   # deadlock_timeout=100ms (issue #25)
npm run db:migrate
BOOKING_STRATEGY=naive PORT=3000 npm run start
BOOKING_STRATEGY=naive npm run harness -- --pattern deadlock-pairs --concurrency 1500 --repeat 3
```

**A scale note, itself part of the evidence:** at a smaller scale
(300 pairs / 600 requests,
[naive-deadlock-pairs-load-run-2026-08-24T04-02-46-818Z.json](naive-deadlock-pairs-load-run-2026-08-24T04-02-46-818Z.json))
the harness measured **zero** deadlocks against unordered `naive` — not
because the code was safe, but because the specific wait-for cycle involved
(below) needs enough concurrent overlap to actually interleave. Bumping to
1,500 pairs / 3,000 requests per run is what surfaced it. This matters for
reading the "after" numbers honestly: "zero at this scale" is meaningful
confirmation precisely because the same scale produced a nonzero rate before
the fix.

## Where the deadlock actually was

`naive`'s multi-seat write has two steps: a single batched
`INSERT INTO booking_seats (booking_id, seat_id) SELECT $1, unnest($2::uuid[])`,
then a single batched `UPDATE seats ... WHERE id = ANY($2)`. Only the first
is genuinely deadlock-capable:

- **`UPDATE ... WHERE id = ANY($2)`**: Postgres plans this as an index or
  bitmap-heap scan whose row-visitation order is plan-determined (by
  physical/index layout), not by the array's literal order — confirmed via
  `EXPLAIN`. Two concurrent requests for the same seat pair, regardless of
  which order their `seat_ids` array lists them in, lock those rows in the
  *same* order here. No wait-for cycle possible through this statement.
- **`INSERT ... SELECT unnest($2::uuid[])`**: `unnest()` preserves array
  order, so this genuinely inserts (and contends for `booking_seats`'
  `UNIQUE(seat_id)` index entry on) each seat in exactly the order the
  client sent. Two concurrent opposite-order requests for the same pair can
  each insert their first seat, then block on the other's uncommitted
  index entry for the second — a real wait-for cycle.

Confirmed directly from the server log during the "before" run:

```
error: deadlock detected
  code: '40P01',
  detail: 'Process 1017 waits for ShareLock on transaction 40230; blocked by process 1035.\n' +
    'Process 1035 waits for ShareLock on transaction 40237; blocked by process 1017.',
  where: 'while inserting index tuple (1,73) in relation "booking_seats_seat_id_key"',
```

## Results

**Before** (unordered `seat_ids`, no deadlock retry — issue #24's committed state), 3 independent repeats at 1,500 pairs / 3,000 requests each:

| Repeat | 201 | 409 | 503 | 500 (`other`, unhandled 40P01) |
|---|---|---|---|---|
| 1 | 1500 | 1496 | 0 | **4** |
| 2 | 1500 | 1497 | 0 | **3** |
| 3 | 1500 | 1499 | 0 | **1** |

8 genuine deadlocks (40P01) across 9,000 requests (0.09%) — small, but real
and reproducible, not a fluke: every one of the 8 is logged server-side with
Postgres's own `DeadLockReport`, and none was retried (naive had no deadlock
handling yet), so each surfaced to the client as an unhandled 500. Zero
double-booking either way (the `booking_seats.seat_id` UNIQUE constraint,
ADR-0008, held throughout).

Full report:
[naive-deadlock-pairs-load-run-2026-08-24T04-05-54-004Z.json](naive-deadlock-pairs-load-run-2026-08-24T04-05-54-004Z.json).

**After** (`seat_ids` sorted case-insensitively before any write; the whole
transactional attempt wrapped in `withDeadlockRetry`), same load, same
scale, 3 independent repeats:

| Repeat | 201 | 409 | 503 | 500 (`other`) |
|---|---|---|---|---|
| 1 | 1500 | 1500 | 0 | **0** |
| 2 | 1500 | 1500 | 0 | **0** |
| 3 | 1500 | 1500 | 0 | **0** |

Zero deadlocks, zero retry-exhaustion, zero hangs, zero double-booking,
across all 9,000 requests. `X-Booking-Retries` was `0` for every response —
the sorting fix alone was enough to eliminate the cycle at this load level;
`withDeadlockRetry` never had to engage as a fallback in this sample, which
is the expected shape (ordering is the primary defense, the retry helper is
there for whatever ordering doesn't cover, ADR-0014).

Full report:
[naive-deadlock-pairs-load-run-2026-08-24T04-09-21-800Z.json](naive-deadlock-pairs-load-run-2026-08-24T04-09-21-800Z.json).

## Before vs. after

| | Before | After |
|---|---|---|
| `seat_ids` ordering | Request order (unordered) | Sorted, case-insensitively |
| Deadlock recovery | None | `withDeadlockRetry` (ADR-0014) |
| Deadlocks / 9,000 requests | **8** | **0** |
| Unhandled 500s | **8** | **0** |
| A deadlock-abort that exhausts retries | N/A (never retried) | Existing `retry_exhausted`/503 (ADR-0015), not a new result kind |
| Double-booked? | No (UNIQUE constraint held) | No |

## Next step

Phase 3 (todo.md): `unique_constraint`, `optimistic`, and `serializable` each
get the same deadlock-safety treatment in their own follow-up tickets
(issues #27–#29), reusing this harness with no separate before/after demo
for the first two — ADR-0016's reasoning applies once the underlying
Postgres phenomenon is already proven here. `pessimistic` and `advisory`
need no such fix (issue #30): their non-blocking lock acquisition (ADR-0006)
already can't enter a wait-for cycle, confirmed clean against `pessimistic`
when the harness itself was built (issue #25) — see
[pessimistic-deadlock-pairs-load-run-2026-08-23T17-11-05-164Z.json](pessimistic-deadlock-pairs-load-run-2026-08-23T17-11-05-164Z.json).
