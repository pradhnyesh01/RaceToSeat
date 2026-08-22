# PRD: Concurrency-Safe Seat Booking Backend

## 1. Overview
A backend service that lets users book seats for a fixed showtime/venue
(modeled as a movie theater, generalizable to concerts or flights) with a
hard, provable guarantee that no seat can ever be double-booked, regardless
of how many concurrent requests target it. The project's primary output is
not just a working API but a **comparative, evidence-backed evaluation** of
which concurrency-control mechanism best satisfies correctness, throughput,
and failure-handling requirements.

## 2. Goals
- G1: Guarantee exactly-one-winner semantics per seat under arbitrary
  concurrent load.
- G2: Preserve per-seat isolation — contention on one seat must not degrade
  performance for other seats.
- G3: Support multi-seat atomic bookings without deadlocking.
- G4: Produce quantitative, reproducible evidence of correctness and
  performance trade-offs across multiple concurrency-control strategies.
- G5 (stretch): Model a realistic hold → confirm → expire booking flow and
  demonstrate resilience to process/connection failure.

## 3. Non-Goals
- Payments, refunds, pricing logic.
- Full authentication/authorization system (a minimal user identifier is
  sufficient).
- Production-grade UI.
- Multi-region / geo-distributed deployment (may be discussed as future
  work).

## 4. Users & Use Cases
| User | Use Case |
|---|---|
| End user | Books 1 or more seats for a showtime; expects immediate success or a clear conflict message. |
| End user (group) | Books multiple seats in a single transaction; expects all-or-nothing semantics. |
| System operator | Needs confidence that inventory (seats) is never oversold, verifiable via load test evidence. |
| Engineer/reviewer | Wants to see *why* a particular concurrency mechanism was chosen, backed by data. |

## 5. Functional Requirements

### FR1 — Seat Booking (single seat)
`POST /bookings` with `{seat_id, user_id, idempotency_key}`.
- Returns `201` with booking confirmation if the seat was available.
- Returns `409 Conflict` immediately if the seat is already booked/held by
  another request — no silent failure, no queuing indefinitely.
- Duplicate requests with the same `idempotency_key` must not create a
  second booking.

### FR2 — Multi-Seat Booking (group/transactional)
`POST /bookings` with `{seat_ids: [...], user_id, idempotency_key}`.
- All-or-nothing: either every requested seat is booked, or none are.
- Must not deadlock when two overlapping multi-seat requests race against
  each other; must resolve via consistent lock ordering and/or
  timeout-and-retry within a bounded time.

### FR3 — Seat Availability Query
`GET /seats?event_id=...` — returns current seat map/status
(`available` / `held` / `booked`). Read path must not be blocked by writes
on unrelated seats.

### FR4 — Hold/Reserve Flow (stretch)
`POST /holds` places a temporary hold (TTL, e.g. 5 minutes) on seat(s).
`POST /holds/{id}/confirm` converts a hold into a booking before expiry.
A background reaper releases expired holds back to `available`.

### FR5 — Booking Cancellation
`DELETE /bookings/{id}` releases a seat back to `available`. Not a primary
focus but needed for a complete, testable system.

## 6. Non-Functional Requirements

### NFR1 — Mutual Exclusion (Correctness)
Of N simultaneous requests for the same seat, exactly 1 succeeds. Verified
via automated load test at N ≥ 1,000, run repeatedly with zero observed
violations.

### NFR2 — Isolation Across Seats
Sustained high-concurrency load (1,000+ req/s) against a single "hot" seat
must not increase p99 latency for requests against other seats by more than
an agreed threshold (e.g. <10% degradation) — this must be measured, not
assumed.

### NFR3 — Deadlock Freedom
Under an adversarial workload of overlapping multi-seat transactions
(constructed specifically to trigger lock-order conflicts), the system must
resolve all transactions within a bounded time (e.g. p99 < 1s) with zero
indefinite hangs, across repeated runs.

### NFR4 — Throughput & Latency Characterization
Each implemented concurrency-control mechanism must be benchmarked under
identical load profiles, reporting: throughput (req/s), p50/p99 latency,
conflict/retry rate, and deadlock rate (where applicable).

### NFR5 — Provable Correctness
Correctness claims must be backed by:
- Reproducible automated load tests (required).
- A formal model (TLA+ or equivalent) checking mutual exclusion and
  deadlock-freedom of the locking protocol (stretch, high value).
- Fault-injection ("chaos") testing — killed connections, injected latency —
  showing no correctness violation under failure (stretch, high value).

## 7. Concurrency-Control Mechanisms In Scope
| Mechanism | Description |
|---|---|
| DB unique constraint | `INSERT ... ON CONFLICT DO NOTHING` on a unique `(seat_id)` index. |
| Pessimistic locking | `SELECT ... FOR UPDATE` before write, within a transaction. |
| Optimistic locking | Version column, compare-and-swap on update, retry on conflict. |
| Advisory locks | `pg_advisory_xact_lock(seat_id)` — no row lock until write-ready. |
| Serializable isolation | `SERIALIZABLE` transaction isolation, letting the DB detect conflicts via predicate locking. |
| (Stretch) Actor/queue model | Per-seat in-memory serialization (e.g. Redis-backed queue or actor), compared against DB-level approaches. |

## 8. System Architecture (High Level)
- **API layer**: REST (or gRPC) service exposing booking endpoints.
- **Data layer**: PostgreSQL — chosen for support of row locks, advisory
  locks, unique constraints, and serializable isolation, enabling direct
  comparison of mechanisms without changing databases.
- **Load-testing harness**: standalone tool (k6/Locust/custom async client)
  capable of firing configurable concurrent load at specific seats/patterns.
- **Background worker** (stretch): reaper process for expired holds.
- **Chaos harness** (stretch): fault-injection tool (e.g. toxiproxy or
  scripted connection kills) run alongside load tests.

## 9. Metrics & Acceptance Criteria
- Zero double-bookings across all mechanism benchmarks and all repeated
  runs — the single hard pass/fail gate.
- Comparative benchmark table/plot across ≥3 mechanisms, ≥3 load levels.
- Documented deadlock rate: nonzero under naive multi-seat locking, zero
  after lock-ordering fix, under identical adversarial load.
- Cross-seat isolation demonstrated with measured latency data, not
  assumption.
- (Stretch) Formal proof artifact and/or chaos test report with zero
  correctness violations under injected failure.

## 10. Risks & Open Questions
- **Risk**: Benchmark results may be sensitive to hardware/DB configuration
  (connection pool size, etc.) — must document test environment precisely
  for reproducibility.
- **Risk**: Formal verification (TLA+) has a learning-curve cost; scope it
  to just the seat-acquisition state machine, not the whole system, to keep
  it tractable.
- **Open question**: Should the final recommended mechanism differ by
  scenario (e.g. optimistic locking for low-contention seats, pessimistic
  or advisory locks for known "hot" seats)? Worth surfacing in the writeup
  even if the implementation ships with one default.

## 11. Deliverables
1. Working backend implementing all in-scope mechanisms behind a
   configurable strategy flag.
2. Load-testing harness + adversarial deadlock harness.
3. Benchmark report (data + plots) comparing mechanisms.
4. (Stretch) TLA+ spec and chaos-test report.
5. Final writeup summarizing trade-offs and the recommended mechanism(s).
