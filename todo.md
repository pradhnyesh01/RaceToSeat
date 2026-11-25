# TODO — Concurrency-Safe Seat Booking Backend

Roadmap follows a risk-driven, incremental (spiral-style) approach: every
phase ends with a working, demonstrable system plus a piece of evidence.

## Phase 0 — Scaffolding
- [x] Design schema: `seats(id, event_id, status, version, held_until, booked_by)`
- [x] Design schema: `bookings(id, seat_id, user_id, idempotency_key, created_at)` —
      shipped as `bookings` + `booking_seats` join table per ADR-0005
- [x] Stand up API skeleton (`POST /bookings`, `GET /seats`)
- [x] Implement **naive** booking logic (read-then-write, no locking) — deliberately
- [x] Build load-generation harness (k6 / Locust / custom async client)
      capable of firing N concurrent requests at one seat — `load-harness/hammer-seat.k6.js`
      (fired by `load-harness/run.ts`, which seeds/verifies)
- [x] Run naive version under load (e.g. 1,000 concurrent requests, 1 seat)
- [x] **Deliverable:** capture evidence of double-booking (logs/screenshot) — "Exhibit A" —
      see [docs/evidence/exhibit-a-naive-double-booking.md](docs/evidence/exhibit-a-naive-double-booking.md)

## Phase 1 — Baseline Correctness
- [x] Implement unique-constraint approach (`INSERT ... ON CONFLICT DO NOTHING`) — `src/strategies/uniqueConstraint.ts` (issue #9)
- [x] Implement pessimistic locking (`SELECT ... FOR UPDATE`) — `src/strategies/pessimistic.ts`, `NOWAIT` per ADR-0006 (issue #10)
- [x] Implement `DELETE /bookings/{id}` (FR5 cancellation, releases seat to `available`) — `src/routes/bookings.ts` (issue #8)
- [x] Re-run Phase 0 load harness against both, using `DELETE /bookings/{id}` to reset seat state between runs — `load-harness/run.ts`'s `--repeat` flag (issue #11)
- [x] Confirm: exactly one success per seat, rest return clean 409s
- [x] Repeat runs to confirm zero double-bookings (not a one-off pass) — 2 independent 1,000-concurrent repeats per mechanism
- [x] **Deliverable:** before/after comparison vs. naive baseline — [docs/evidence/exhibit-b-phase1-correctness.md](docs/evidence/exhibit-b-phase1-correctness.md)

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
- [ ] Load test: expire holds mid-flight under concurrent confirm attempts
- [ ] **Deliverable:** evidence of no double-confirm, no permanently stuck seats

> Note: this phase no longer includes a standalone "idempotency-key dedupe table" (an earlier draft of
> this roadmap called for one). It's superseded by the `UNIQUE` constraint on `bookings.idempotency_key`
> + lookup-on-conflict, in place since Phase 0/1 — see RaceToSeat#1.

## Phase 6 — Formal Rigor: Proof + Chaos Testing (high priority, don't defer)

Umbrella: #42. Scope settled via a grilling session (see CONTEXT.md: Fault, Ambiguous outcome, Oracle,
Correctness violation, Robustness finding). Two independent tracks; do both tracers (F1, C1)
before deepening either. Dependencies: F1→{F2,F3}→F4→F5, C1→{C2,C3}→C5, C4 off C2.
ADRs 0021–0023 are written as the relevant tickets land, not up front.

**Formal track** (TLA+, TLC in a pinned Docker image, `npm run formal:check`)
- [x] #43 F1 (tracer): core spec — claim + multi-seat Booking, mutual-exclusion & atomicity invariants, Docker TLC runner, naive-claim negative control
- [x] #45 F2: deadlock A/B — unsorted blocking acquisition yields a TLC counterexample; the fixed protocol is clean
- [x] #46 F3: lifecycle layer — Hold, Confirm, Expire (monotonic flag), Reaper, Cancel; reaper liveness under weak fairness
- [x] #47 F4: crash / ambiguous-commit / idempotent-retry layer
- [ ] #48 F5: spec-action → SQL (`file:line`) mapping table + Exhibit G

**Chaos track** (Toxiproxy compose profile + scripted `pg_terminate_backend`)
- [x] #44 C1 (tracer): fault driver, four DB-state oracles + corrupted-state unit tests, scratch-DB (no UNIQUE) negative control; backend-kill vs `pessimistic`, measured on unmodified code
- [x] #49 C2: latency, partition+heal, app SIGKILL across all six mechanisms
- [x] #50 C3: hold/confirm/reaper under fault (`pessimistic`)
- [ ] #51 C4 (stretch): Postgres restart under load
- [x] #52 C5: Exhibit H; each Robustness finding filed as its own fix ticket with before/after rerun
  (Exhibit H written; the seven findings are *drafted* in `docs/phase6-robustness-ticket-drafts.md` — GitHub issues not yet filed, pending review)
  (C5 must reconcile finding numbering: C2 and C3 each used "R5" for different findings — C2's advisory 500 vs C3's stalled reaper — and C2 also has an R6)

**Cut order if time runs short** (first dropped first): C4, F4, reaper liveness in F3,
C2 narrowed to `pessimistic`/`optimistic`/`serializable`, F2. Never cut: F1, C1, the four
oracles, every negative control.

- [ ] **Deliverable:** Exhibits G and H exist, `npm run formal:check` passes, every negative
  control is shown to fail, chaos report shows zero Correctness violations, Robustness
  findings listed with follow-up issue links

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
