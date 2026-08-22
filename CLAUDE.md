# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

Phase 0 (scaffolding) and Phase 1 (baseline correctness) are complete. The TypeScript/
Fastify API (`src/`) now supports three interchangeable `BOOKING_STRATEGY` mechanisms —
`naive`, `unique_constraint`, `pessimistic` (`src/strategies/`) — sharing one Postgres
schema (`db/schema.sql`, including ADR-0008's `booking_seats.seat_id UNIQUE` constraint)
and one idempotency helper (`src/strategies/idempotency.ts`). `DELETE /bookings/{id}`
(cancellation) is implemented once, independent of strategy. The k6-based load harness
(`load-harness/hammer-seat.k6.js` + `run.ts`) now reuses and resets one seat across
repeated runs via the real `DELETE` endpoint (`--repeat` flag), rather than reseeding.
All of this is exercised by `npm test`. See
[docs/evidence/exhibit-a-naive-double-booking.md](docs/evidence/exhibit-a-naive-double-booking.md)
(Phase 0, naive fails under load) and
[docs/evidence/exhibit-b-phase1-correctness.md](docs/evidence/exhibit-b-phase1-correctness.md)
(Phase 1, both new mechanisms hold under load) for the before/after evidence.
Phases 2+ are not yet implemented. Before extending the implementation,
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
