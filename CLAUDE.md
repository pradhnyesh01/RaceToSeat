# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

Phase 0 (scaffolding), Phase 1 (baseline correctness), and Phase 2 (mechanism
expansion + benchmark harness) are complete. The TypeScript/Fastify API (`src/`) now
supports six interchangeable `BOOKING_STRATEGY` mechanisms — `naive`, `unique_constraint`,
`pessimistic`, `optimistic`, `advisory`, `serializable` (`src/strategies/`) — sharing one
Postgres schema (`db/schema.sql`, including ADR-0008's `booking_seats.seat_id UNIQUE`
constraint) and one idempotency helper (`src/strategies/idempotency.ts`). `BookSeatResult`
carries a `retry_exhausted` kind (HTTP 503, ADR-0012), and every `POST /bookings` response
carries an `X-Booking-Retries` header. `DELETE /bookings/{id}` (cancellation) is implemented
once, independent of strategy. The k6-based load harness now has two sibling load patterns —
`hammer-seat.k6.js` (all-same-seat contention) and `spread-across-seats.k6.js`
(zero-contention per-mechanism overhead) — both selectable via `run.ts --pattern`, both
resetting via the real `DELETE` endpoint (`--repeat` flag) rather than reseeding, and both
tallying `X-Booking-Retries` and retry-exhaustion (HTTP 503) as their own metrics. A new
aggregation script (`load-harness/aggregate.ts`, `npm run harness:aggregate`) reads the
JSON reports the harness writes and produces a Markdown comparison document. All of this is
exercised by `npm test`. See
[docs/evidence/exhibit-a-naive-double-booking.md](docs/evidence/exhibit-a-naive-double-booking.md)
(Phase 0, naive fails under load),
[docs/evidence/exhibit-b-phase1-correctness.md](docs/evidence/exhibit-b-phase1-correctness.md)
(Phase 1, the first two new mechanisms hold under load), and
[docs/evidence/exhibit-c-phase2-comparison.md](docs/evidence/exhibit-c-phase2-comparison.md)
(Phase 2, all six mechanisms benchmarked against each other) for the before/after evidence.

Phase 3 (multi-seat transactions + deadlock freedom) is complete. `POST /bookings` accepts
multi-seat `seat_ids` across all six mechanisms (issue #24). A third k6 load pattern,
`deadlock-pairs.k6.js` (issue #25), seeds disjoint 2-seat pairs and fires both lock
orderings of each pair concurrently to adversarially trigger deadlocks; test/dev Postgres's
`deadlock_timeout` is tuned to 100ms (`docker-compose.yml`) so a genuine deadlock's
detect-and-abort cycle stays inside NFR3's latency budget. `naive`'s multi-seat path now
sorts `seat_ids` before writing and wraps its transactional attempt in `withDeadlockRetry`
(`src/db/pool.ts`, ADR-0014) — see
[docs/evidence/exhibit-d-naive-multiseat-deadlock.md](docs/evidence/exhibit-d-naive-multiseat-deadlock.md)
(issue #26) for measured before/after deadlock rates. `unique_constraint` (issue #27) and
`optimistic` (issue #28) now ship the same fix — sorted `seat_ids` + `withDeadlockRetry`, no
separate before/after demo per ADR-0016 — `optimistic`'s CAS-retry loop restarting cleanly
from a fresh read (`attempt = 0`) on every deadlock-triggered retry rather than resuming
mid-loop, with its existing ordinary CAS-conflict retry accounting (ADR-0009) left unaffected.
`serializable` (issue #29) now ships the fix too, but shaped differently from the other
three: it does NOT use `withDeadlockRetry` (ADR-0014) — nesting a second retry-from-`BEGIN`
wrapper around `withSerializableTransaction`'s own retry-from-`BEGIN` loop (ADR-0011) would
double-`BEGIN` on every retry — so that existing loop is extended instead to treat a deadlock
abort (`40P01`) as retriable on the same counter/cap/backoff it already applies to a genuine
serialization failure (`40001`). Unlike the other three mechanisms' near-zero contention
baseline, `serializable`'s retry/503 rate under the adversarial harness is legitimately
nonzero regardless of deadlocks (already true before this ticket, ADR-0013) — so the evidence
for this fix is "zero unhandled errors, zero hangs, zero double-booking" rather than "zero
retries." `pessimistic` and `advisory` needed no such fix (ADR-0006's non-blocking lock
acquisition already can't deadlock) but now ship a consistency pass sorting `seat_ids` for
uniformity with the other four (issue #30), confirmed via the adversarial harness showing
zero deadlocks/hangs/double-bookings across repeated runs against both mechanisms — the last
item for Phase 3, which is now complete. Issue #31 then extracted two shared helpers into
`src/strategies/idempotency.ts`: `normalizeSeatIds` (lowercase + sort, the identical
expression `naive`/`unique_constraint`/`optimistic`/`serializable` all duplicated) and
`runDeadlockRetryBooking` (mirroring the existing `runTransactionalBooking`'s shape but
wrapping `withDeadlockRetry` instead of `withTransaction`, mapping
`DeadlockRetriesExhaustedError` to `{ kind: "retry_exhausted", retries }` internally).
`naive.ts` and `uniqueConstraint.ts` now use both helpers; `optimistic.ts` uses both too,
its CAS-retry loop unaffected; `serializable.ts` uses only `normalizeSeatIds` (it extends its
own `withSerializableTransaction` loop rather than `withDeadlockRetry`, per ADR-0014).
`pessimistic.ts`/`advisory.ts` are not call sites for either helper (out of this ticket's
scope; ADR-0006's non-blocking lock acquisition doesn't need deadlock retry, and issue #31's
acceptance criteria scoped `normalizeSeatIds` to the four mechanisms whose sort is either
load-bearing or already documented that way). No observable behavior change — the full test
suite passes unmodified.

Phase 4 (cross-seat isolation verification) has begun: issue #33 lays its foundation. A
fourth k6 load pattern, `cross-seat-isolation.k6.js`, fires a hot-seat burst (all-VUs-race-
one-seat, `hammer-seat.k6.js`'s shape) and a background stream (one-VU-per-distinct-seat,
`spread-across-seats.k6.js`'s shape) as two k6 scenarios executing concurrently in one
invocation, rather than approximating "at the same time" by orchestrating two separate
processes — selectable as `run.ts --pattern isolation`, with `--background-only` dropping
the hot-seat stream for the matched no-contention baseline. Each stream's status/retry/
latency/throughput metrics are tallied under its own prefixed k6 metric name (`hot_*`/`bg_*`)
and reported under separate `hotStream`/`backgroundStream` keys in the JSON report, rather
than merged. One correctness fix along the way: the background stream indexes its seat list
by `exec.scenario.iterationInTest`, not `__VU` — k6 draws VU ids for concurrently-running
scenarios from one shared pool rather than handing each scenario a contiguous block, so
`__VU`-based indexing (safe for the three earlier, single-scenario patterns) silently
misassigned seats once two scenarios ran side by side (confirmed by direct experimentation
during this ticket). The shared dev/test Postgres's `max_connections` and the app's `pool.ts`
default are both raised (100→600, 50→500, `docker-compose.yml`/`src/db/pool.ts`) so pool/
connection admission doesn't dominate the isolation signal at 1,000+1,000-request peak
concurrency — documented inline with the sizing rationale and residual-effect caveat, no new
ADR, mirroring the `deadlock_timeout` tuning precedent above. One caveat worth carrying into
Phase 4's actual measurement work (issue #35 and beyond): both streams share the app's one
pg `Pool`, so under a blocking mechanism (`pessimistic`'s `SELECT ... FOR UPDATE`) pool-
connection starvation from the hot-seat queue could produce a background-latency spike that
looks like a genuine NFR2 violation but is actually pool exhaustion, not row-lock contention
— noted inline in `cross-seat-isolation.k6.js`. issue #33 is foundation only: it does not
itself produce isolation-degradation numbers or an exhibit document — full test suite passes
unmodified.

Issue #34 adds the unit-level half of Phase 4's cross-seat proof, alongside issue #33's
load-harness half: each of the six strategy test files (`test/strategies/*.test.ts`) now
carries a deterministic test showing a request for an unrelated seat resolves quickly while
another seat is held/contended, extending the `withHeldRowLock`/`withHeldSeatLock` pattern
`pessimistic`/`advisory` already used for their own same-seat "losing request resolves fast"
tests to a cross-seat variant, reusing those same two helpers unchanged. The other four
mechanisms hold seat A via their own distinguishing write, standing in for "another in-flight
booking on this mechanism currently touches this row" rather than a one-size-fits-all stub:
`naive`'s own unguarded `UPDATE seats SET status = 'booked' ...`, `unique_constraint`'s own
`INSERT INTO booking_seats ... ON CONFLICT DO NOTHING`, `optimistic`'s own CAS `UPDATE ...
WHERE version = $3 AND status = 'available'`, and `serializable`'s own
`BEGIN ISOLATION LEVEL SERIALIZABLE` read-then-write — each held open, uncommitted, on a
separate connection, then rolled back rather than committed (a synthetic in-flight writer, not
a booking meant to persist; for `serializable` specifically, rolling back also means the hold
can never complete an SSI conflict cycle, so the test only proves "no unwanted blocking," not
"zero retries," consistent with ADR-0013's already-nonzero baseline for that mechanism). A
code-review pass surfaced that all six tests shared an identical assertion/timing shape (seed
two seats, time a request through the held claim, assert 201 and sub-2s latency) with only the
hold function differing — consolidated into a new `runCrossSeatIsolationContractTest` in
`test/bookingContract.ts`, parameterized by each file's hold function, mirroring the existing
`runBookingConcurrencyContractTest` sharing convention. No production code changed; the full
test suite passes (118 tests, up from 112) and `npm run typecheck` is clean.

Issue #35 closes out Phase 4 with the actual measurement: `load-harness/aggregate.ts` gains a
second mode, `--exhibit e` (default remains `--exhibit c`, unchanged), reading the `isolation`-
pattern reports issue #33's harness writes rather than building a separate generation path —
same "most-recent-report-wins" dedup and Markdown-table-rendering conventions as Exhibit C, but
keyed by `(strategy, backgroundOnly)` and reading each run's *background-stream* p99 (NFR2 asks
whether the hot seat degrades *other* seats, not its own latency). All six mechanisms were run
at the widened connection configuration (issue #33): background-only baseline and combined
(hot + background) variants, each `--repeat 2`, one degradation percentage computed per
mechanism from the two repeat-averaged p99s. Two mechanisms exceed NFR2's 10% threshold —
`pessimistic` (+37.5%) and `optimistic` (+14.4%) — reported as findings in the new
[docs/evidence/exhibit-e-phase4-isolation.md](docs/evidence/exhibit-e-phase4-isolation.md),
not treated as a blocker (this project's single hard gate is zero double-booking, not NFR2;
per issue #35's scope, investigating/fixing the degradation is its own follow-up ticket). A
negative control — `pessimistic`'s combined variant run once against Postgres reconfigured to
the project's prior, un-widened `max_connections=100`/`PG_POOL_MAX=50` (container stopped,
recreated with the old flags against the same named volume, then restored via `docker compose
up -d` afterward) — measured +405.6% degradation, confirming the harness can actually detect a
real violation before six results that are mostly expected to pass. That negative-control run's
report is marked with a `negative-control` filename suffix so `aggregate.ts`'s per-strategy
dedup doesn't confuse it with `pessimistic`'s real matrix cell. Zero double-booking across all
six mechanisms and both configurations throughout. Phase 4 (todo.md) is complete; full test
suite passes unmodified (118 tests) and `npm run typecheck` is clean.

A same-session follow-up grilling pass on Exhibit E's two findings split them: `pessimistic`'s
+37.5% didn't reproduce (three independent single-repeat reruns swung from -41% to +4%,
including negative-degradation runs — 2-repeat noise, not a stable signal), so it was
re-measured at `--repeat 5` and Exhibit E corrected directly (now -13.6%, PASS; the negative
control's degradation shifted from +405.6% to +374.7% since its reference is `pessimistic`'s own
widened-config baseline). `aggregate.ts`'s isolation table now reports each mechanism's actual
repeat count, since it's no longer uniformly 2 across all six. No GitHub issue was needed for
this — it resolved same-session as a correction, not tracked work. `optimistic`'s +14.4% did
reproduce (direction consistently positive across reruns, magnitude often far larger, up to
+573%), so it's tracked as [issue #36](https://github.com/pradhnyesh01/RaceToSeat/issues/36): a
real investigation, not yet started, with a code-derived starting hypothesis (an ordinary
CAS-miss under hot-seat contention costs ~4 extra round-trips vs. the other five mechanisms'
single-shot check — `optimistic.ts`'s initial `readSeats` + `SAVEPOINT` + CAS miss +
`ROLLBACK TO SAVEPOINT` + a second `readSeats` for ADR-0009's cancellation-race check) and a
scoped pool-size scaling test to confirm or rule it out before committing to a fix.

Issue #36 resolved same-session: `optimistic` was re-measured at `--repeat 5` (matching
`pessimistic`'s bar), landing at a corrected +60.1% — much larger than the original +14.4%, and
(unlike `pessimistic`) a real, reproducible signal, not noise. The CAS-miss hypothesis was
confirmed empirically, not just analytically: comparing Postgres query-log volume for an
identical 50-concurrent single-seat burst, `naive` issued 169 total statements vs
`optimistic`'s 405 — ~2.4x. The pool-size scaling test (`PG_POOL_MAX` 500→1000, Postgres
`max_connections` temporarily raised to 1200 to give it headroom, then restored to 600) only
modestly reduced the degradation (+60.1%→+52.3%), ruling out connection-pool spillover as the
primary cause and confirming it's genuine extra per-request Postgres work from the CAS-miss
path's shape (initial `readSeats` + `SAVEPOINT` + CAS miss + `ROLLBACK TO SAVEPOINT` + a second
`readSeats`) — not a mechanism-agnostic infrastructure problem, unlike the negative control's
own pool-queuing finding. Final recommendation: **document as an inherent trade-off of the
CAS-retry design, not fix** — the second `readSeats` is ADR-0009's correctness mechanism for
distinguishing a genuine conflict from a concurrent cancellation race, not incidental overhead;
removing it would weaken that guarantee, and a real fix would need a different query shape
entirely (changing what Exhibit C's own comparative benchmark measures for this mechanism),
which is out of scope for an isolation-measurement ticket. `aggregate.ts` gained a third small
matrix (alongside the main table and the negative control) for pool-scaling reports, marked the
same hand-applied-filename way as the negative control. `docs/evidence/exhibit-e-phase4-isolation.md`
updated throughout to reflect all of this. Phase 4 and its NFR2 follow-up work are both now
fully closed out (issues #32-#36 all closed); full test suite passes unmodified (118 tests) and
`npm run typecheck` is clean.

Before extending the implementation,
read all three planning docs in full; they define scope, sequencing, and acceptance
criteria that should govern implementation decisions:

- [problem-statement.md](problem-statement.md) — the core bug being solved (lost-update
  race condition in read-then-write booking) and why it matters.
- [PRD.md](PRD.md) — functional/non-functional requirements, the concurrency mechanisms
  in scope, and acceptance metrics.
- [todo.md](todo.md) — the phased implementation roadmap (Phase 0–8) with priority notes.

When starting implementation, follow the phase ordering in todo.md rather than
jumping ahead — later phases (multi-seat transactions, isolation benchmarking, formal
verification) depend on infrastructure (load-test harness, benchmark harness) built in
earlier phases.

## Project concept

A backend that books seats for a fixed showtime/venue with a hard guarantee against
double-booking under concurrent load. The deliverable is not just a working API but a
**comparative, evidence-backed evaluation** of five concurrency-control mechanisms,
benchmarked against each other:

1. DB unique constraint (`INSERT ... ON CONFLICT DO NOTHING`)
2. Pessimistic locking (`SELECT ... FOR UPDATE`)
3. Optimistic locking (version column, compare-and-swap, retry on conflict)
4. Advisory locks (`pg_advisory_xact_lock(seat_id)`)
5. Serializable isolation (`SERIALIZABLE` transaction level)
6. (Stretch) Actor/per-seat-queue model, compared against the DB-level approaches

The implementation should support switching between mechanisms behind a configurable
strategy flag, so the same API surface and load-testing harness can be re-run against
each one for direct comparison.

## Architecture (planned)

- **API layer**: REST (or gRPC) exposing `POST /bookings`, `GET /seats`,
  `DELETE /bookings/{id}`, and (stretch) `POST /holds` / `POST /holds/{id}/confirm`.
- **Data layer**: PostgreSQL, chosen specifically because it supports all five
  in-scope concurrency mechanisms without switching databases.
- **Load-testing harness**: a standalone tool (k6/Locust/custom async client) that
  fires configurable concurrent load at specific seats/patterns — this is a first-class
  deliverable, not test scaffolding, since correctness claims must be demonstrated
  under real concurrency rather than asserted from sequential tests.
- **Adversarial deadlock harness**: constructs overlapping multi-seat transactions
  with opposing lock orders to force deadlocks, used to validate the lock-ordering fix.
- **Background reaper** (stretch): releases expired seat holds.
- **Chaos harness** (stretch): fault injection (e.g. toxiproxy, scripted connection
  kills) run alongside load tests to prove correctness survives failure, not just the
  happy path.

## Key design constraints to preserve

- **Per-seat isolation**: contention/locking on one seat must never degrade latency or
  throughput for unrelated seats — the design must not collapse into a single global
  queue. This is a measured NFR (NFR2), not an assumption; any implementation must stay
  benchmarkable per-seat.
- **Deadlock freedom for multi-seat bookings**: resolved via consistent lock ordering
  (e.g. sort `seat_ids` before acquiring) and/or timeout-with-backoff retry — required
  whenever a request touches more than one seat.
- **Idempotency**: duplicate requests carrying the same `idempotency_key` must not
  create a second booking.
- **Correctness over convenience**: every mechanism must independently satisfy "exactly
  one winner per seat under N concurrent requests" — this is the single hard pass/fail
  gate for the whole project (see PRD.md Metrics & Acceptance Criteria). Do not
  introduce a mechanism or optimization that weakens this guarantee for throughput.

## Formal verification & chaos testing (Phase 6)

Per todo.md's priority notes, this is the most differentiating part of the project
relative to a typical tutorial version of this system and should not be dropped under
deadline pressure — a thin version (chaos-only or proof-only) is the acceptable
fallback, not skipping it. If asked to scope down, cut elsewhere first (e.g. Phase 7
scale-out, or trimming the mechanism count in Phase 2) before cutting Phase 6.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues (via the `gh` CLI) in `pradhnyesh01/RaceToSeat`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.
