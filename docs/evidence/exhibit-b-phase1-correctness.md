# Exhibit B — unique-constraint and pessimistic-locking mechanisms hold under load

Phase 1 deliverable (todo.md, issue #11): evidence that the two new booking
mechanisms — `unique_constraint` (issue #9) and `pessimistic` (issue #10) —
each produce exactly one winner per seat under the same concurrent load that
broke naive in [Exhibit A](exhibit-a-naive-double-booking.md).

## Method

Same harness as Exhibit A (`load-harness/run.ts` + `load-harness/hammer-seat.k6.js`),
extended for Phase 1 (issue #11) to run repeatedly against one seat within a
single invocation: it seeds the seat once, then between repeats resets it via
the real `DELETE /bookings/{id}` endpoint (issue #8) — not raw SQL, not
reseeding — so each repeat starts from a genuinely `available` seat reached
the same way a real client would reach it.

```bash
docker compose up -d
npm run db:migrate   # picks up ADR-0008's booking_seats.seat_id UNIQUE constraint
npm run db:seed

BOOKING_STRATEGY=unique_constraint PORT=3001 npm run start
BOOKING_STRATEGY=unique_constraint npm run harness -- --concurrency 1000 --repeat 2 --base-url http://localhost:3001

BOOKING_STRATEGY=pessimistic PORT=3002 npm run start
BOOKING_STRATEGY=pessimistic npm run harness -- --concurrency 1000 --repeat 2 --base-url http://localhost:3002
```

## Results (two independent repeats each, 1,000 concurrent requests per repeat)

| Mechanism | Repeat | Winners (should be 1) | HTTP 201s | HTTP 409s |
|---|---|---|---|---|
| `unique_constraint` | 1 | **1** | 1 | 999 |
| `unique_constraint` | 2 | **1** | 1 | 999 |
| `pessimistic` | 1 | **1** | 1 | 999 |
| `pessimistic` | 2 | **1** | 1 | 999 |

Full reports:
[unique_constraint-load-run-2026-08-22T17-49-29-702Z.json](unique_constraint-load-run-2026-08-22T17-49-29-702Z.json),
[pessimistic-load-run-2026-08-22T17-49-47-096Z.json](pessimistic-load-run-2026-08-22T17-49-47-096Z.json)
(each file contains both repeats, since the reset-and-reuse harness captures
them as one combined report per invocation).

## Before vs. after

| | Before (Exhibit A, naive, pre-ADR-0008) | After (this exhibit) |
|---|---|---|
| Mechanism | Naive read-then-write, no lock, no constraint | `unique_constraint`: `INSERT ... ON CONFLICT DO NOTHING`; `pessimistic`: `SELECT ... FOR UPDATE NOWAIT` |
| Winners per seat (1,000 concurrent requests) | 14, then 50 | 1, then 1 (both mechanisms, both repeats) |
| Gate (PRD: "exactly 1 succeeds") | **Failed**, both runs | **Passed**, all four runs |

Both mechanisms satisfy the single hard pass/fail gate (PRD §Metrics &
Acceptance Criteria) under 1,000-way concurrency, repeated independently
rather than asserted from a single run. Naive itself is no longer
reproducible as broken (see the note in Exhibit A) since ADR-0008's shared
constraint now backstops every mechanism — but naive's read-then-write shape
is retained deliberately, as the baseline every other mechanism is compared
against.

## Next step

Phase 2 (todo.md) adds the remaining mechanisms (advisory locks, serializable
isolation) and benchmarks all of them against each other, not just against
the pass/fail gate.
