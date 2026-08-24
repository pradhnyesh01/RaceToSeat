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
item for Phase 3, which is now complete. A follow-up (issue #31) will extract the
`withDeadlockRetry`-wrap/catch pattern now duplicated across `naive.ts`, `uniqueConstraint.ts`,
and `optimistic.ts` into a shared helper (not `serializable.ts`, which never uses that helper),
deferred until #28 landed so the extraction covers every real call site. Before extending
the implementation,
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
