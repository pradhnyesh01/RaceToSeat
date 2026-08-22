# TODO — Concurrency-Safe Seat Booking Backend

Roadmap follows a risk-driven, incremental (spiral-style) approach: every
phase ends with a working, demonstrable system plus a piece of evidence.

## Phase 0 — Scaffolding
- [ ] Design schema: `seats(id, event_id, status, version, held_until, booked_by)`
- [ ] Design schema: `bookings(id, seat_id, user_id, idempotency_key, created_at)`
- [ ] Stand up API skeleton (`POST /bookings`, `GET /seats`)
- [ ] Implement **naive** booking logic (read-then-write, no locking) — deliberately
- [ ] Build load-generation harness (k6 / Locust / custom async client)
      capable of firing N concurrent requests at one seat
- [ ] Run naive version under load (e.g. 1,000 concurrent requests, 1 seat)
- [ ] **Deliverable:** capture evidence of double-booking (logs/screenshot) — "Exhibit A"

## Phase 1 — Baseline Correctness
- [ ] Implement unique-constraint approach (`INSERT ... ON CONFLICT DO NOTHING`)
- [ ] Implement pessimistic locking (`SELECT ... FOR UPDATE`)
- [ ] Re-run Phase 0 load harness against both
- [ ] Confirm: exactly one success per seat, rest return clean 409s
- [ ] Repeat runs to confirm zero double-bookings (not a one-off pass)
- [ ] **Deliverable:** before/after comparison vs. naive baseline

## Phase 2 — Mechanism Expansion + Benchmark Harness
- [ ] Implement optimistic locking (version column + retry-on-conflict)
- [ ] Implement Postgres advisory locks (`pg_advisory_xact_lock`)
- [ ] Implement SERIALIZABLE isolation level approach
- [ ] Extend benchmark harness: parameterize by mechanism, concurrency level,
      contention pattern (all-same-seat vs. spread-across-seats)
- [ ] Capture throughput, p50/p99 latency, conflict/retry rate per mechanism
- [ ] **Deliverable:** comparison table/plot across all 5 mechanisms × multiple load levels

## Phase 3 — Multi-Seat Transactions & Deadlocks
- [ ] Extend API to accept multiple `seat_ids` per booking request
- [ ] Construct adversarial workload (overlapping seat sets, opposite lock order)
- [ ] Run adversarial load against naive multi-seat locking — capture deadlocks/hangs
- [ ] Implement consistent lock ordering (sort seat_ids before acquiring)
- [ ] Implement timeout + exponential-backoff retry as fallback layer
- [ ] Re-run adversarial load — confirm deadlock rate drops to zero
- [ ] **Deliverable:** deadlock rate before/after ordering fix, same load

## Phase 4 — Cross-Seat Isolation Verification
- [ ] Design test: hammer seat A with 1,000+ concurrent requests
- [ ] Simultaneously run normal-latency requests against seats B–Z
- [ ] Measure whether B–Z latency/throughput degrades
- [ ] Set and check against an explicit threshold (e.g. <10% p99 degradation)
- [ ] **Deliverable:** isolation test report with numbers, not assumption

## Phase 5 — Realistic Booking Flow (stretch)
- [ ] Add `held` status with TTL to seat state machine
- [ ] Implement reaper (background worker / Redis TTL) to release expired holds
- [ ] Implement `POST /holds` and `POST /holds/{id}/confirm` endpoints
- [ ] Add idempotency-key dedupe table to prevent duplicate client-retry bookings
- [ ] Load test: expire holds mid-flight under concurrent confirm attempts
- [ ] **Deliverable:** evidence of no double-confirm, no permanently stuck seats

## Phase 6 — Formal Rigor: Proof + Chaos Testing (high priority, don't defer)
- [ ] Write lightweight TLA+ (or Alloy) spec of the seat-acquisition state machine
- [ ] Model-check mutual exclusion invariant
- [ ] Model-check deadlock-freedom invariant
- [ ] Set up fault-injection harness (toxiproxy or scripted connection kills)
- [ ] Run chaos test: kill DB connections mid-transaction under high concurrency
- [ ] Run chaos test: inject network latency/partition, verify recovery correctness
- [ ] **Deliverable:** proof + chaos test report, zero correctness violations

## Phase 7 — Stretch: Scale-Out Angle (optional)
- [ ] Implement actor-model or per-seat-queue variant (Redis-backed or in-process)
- [ ] Benchmark against DB-level mechanisms from Phase 2
- [ ] (Optional) discuss/prototype sharding by venue/event

## Phase 8 — Writeup
- [ ] Write comparative mechanism analysis (throughput/latency/failure-mode tradeoffs)
- [ ] Include deadlock before/after evidence (Phase 3)
- [ ] Include isolation test results (Phase 4)
- [ ] Include proof + chaos results (Phase 6)
- [ ] State explicit recommendation: which mechanism for which scenario
- [ ] Add a short "how this differs from the standard tutorial version" note

---

## Priority Notes
- Phases 0–2 are the non-negotiable core — do not compress these to add scope elsewhere.
- Phase 6 (formal proof + chaos testing) is the most differentiating section relative to
  typical versions of this project — protect time for it early rather than risking it
  being cut under deadline pressure. A thin version (chaos testing only, or proof only)
  is acceptable if time is short — dropping it entirely is not recommended.
- Suggested time split (2–3 week project): Phases 0–2 ≈ 30%, Phase 3–4 ≈ 20%,
  Phase 5 ≈ 15%, Phase 6 ≈ 25%, Phase 7–8 ≈ 10%.
