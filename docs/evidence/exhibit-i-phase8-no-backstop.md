# Exhibit I — Phase 8: each Mechanism with the Backstop removed

Phase 8 deliverable (todo.md, issue #73 under the spec in #72). Every Mechanism passes the project's
one hard gate (exactly one winner per seat) on the shared schema, but that schema carries a
**Backstop** — a `UNIQUE(seat_id)` constraint beneath every Mechanism and the Control (ADR-0008,
CONTEXT.md) — so "all pass" does not show that a Mechanism is correct on its own. The only run that
ever removed the Backstop before this exhibit was the Control's (Exhibit A's history and Exhibit H's
negative controls). This exhibit removes it from each Mechanism and reports what is left.

Verdicts are read from stored database state by the chaos harness's Oracles, never from HTTP
responses (ADR-0022). Every number below is recomputed from the per-run JSON reports in
`docs/evidence/exhibit-i/` by `npm run harness:aggregate -- --exhibit i`.

## Headline

- **Detector check.** Control flagged in 6 of 6 runs. The checker is known to see a double-booking at this load, so a "held" verdict below comes from a checker that can fail.
- **The four coordinated Mechanisms** (`pessimistic`, `optimistic`, `advisory`, `serializable`) held in 24 of 24 measured runs, with the Backstop removed; in none of them was a Seat claimed twice or a Booking torn.
- **`unique_constraint` cannot stand alone**: 6 of 6 runs were inoperative. It is the Backstop relied on as the only defense, so removing the Backstop removes the Mechanism.
- **Predictions** (first written in issue #72, before any run; see "Order of events"): as predicted for `naive`, `pessimistic`, `optimistic`, `advisory`, `serializable`; **missed** for `unique_constraint`.
- **Concurrency ceiling.** Single-seat contention ran at 60 concurrent requests, not the 1,000 the spec asked for: the chaos harness could not carry 1,000 on this machine (see "Why 60 concurrent, not 1,000").
- **Held is a safety verdict, not a liveness one**: `advisory`, `serializable` booked fewer Bookings than a fully served run would in 4 run(s) (see the "Bookings created / expected" column) without ever double-booking.

## Method

For each Mechanism and the Control, and each workload, one chaos-harness run (`load-harness/chaos/run.ts`, no Fault) against a
throwaway database built from the real `db/schema.sql` with the Backstop (its `UNIQUE(seat_id)` constraints) dropped by name
(`--db scratch-no-unique`, ADR-0023: the production schema, the application and the shared dev database are never touched).
The application under test is `src/server.ts`, unmodified. Every Idempotency Key is replayed afterwards, then the Oracles
read stored state: (1) mutual exclusion, (2) no torn state, (3) idempotent recovery, (4) liveness.

- **Single-seat contention** (`hammer-seat`): 60 concurrent requests for one seat. A fully served run creates exactly 1 Booking.
- **Overlapping multi-seat pairs** (`deadlock-pairs`): 30 disjoint two-seat pairs, both orderings of each pair fired at once (60 requests).
  A fully served run creates 30 Bookings, one per pair. This tests the all-or-nothing property without the Backstop, not only mutual exclusion.
- **Repeats:** 3 per cell, driven by `load-harness/chaos/exhibitIMatrix.ts`. A **smoke run** of every strategy came first (below).

**Order of events.** The predictions were first written in issue #72, before any run: the Control and `unique_constraint` double-book
without the Backstop; the other four hold. The smoke runs came next, and had already contradicted the `unique_constraint` prediction (every
insert failed) by the time `PREDICTIONS` was committed in `load-harness/exhibitI.ts`; it was kept as written, so the miss is visible
and not edited away. The `inoperative` verdict was added after that smoke result, because the Oracles pass on an empty database. The measured
matrix ran after all of that.

```bash
docker compose --profile chaos up -d toxiproxy
npx tsx load-harness/chaos/exhibitIMatrix.ts --smoke      # first: does each strategy start and book here?
npx tsx load-harness/chaos/exhibitIMatrix.ts --reps 3     # the measured matrix
npm run harness:aggregate -- --exhibit i                  # this document
```

## Results: predicted against observed

Verdicts: **held** (Oracles pass and Bookings were created), **double-booked** (the Oracle for Seat exclusivity or for torn Bookings failed: a Seat claimed
twice, or a Booking that does not hold the Seats it asked for), **other-violation** (any other Oracle failed), **inoperative** (nothing was booked at all, so the
Oracles pass on an empty database, which is not a pass). `naive` is the Control, not a Mechanism (CONTEXT.md); its rows describe the Control *without*
the Backstop, the only configuration in which it fails.

| Mechanism or Control | Workload | Role | Predicted | Repeats | Without the Backstop | Bookings created / expected | Prediction |
|---|---|---|---|---|---|---|---|
| `naive` | hammer-seat | Control | double-booked | 3 | double-booked 3/3 (seat bf2df0ba-c815-4968-b9bb-2ac6ce9606fd is claimed by 17 bookings) | 25/3 | as predicted |
| `naive` | deadlock-pairs | Control | double-booked | 3 | double-booked 3/3 (seat 000bb8c6-e087-437b-b14e-55870519dc05 is claimed by 2 bookings) | 145/90 | as predicted |
| `unique_constraint` | hammer-seat | Mechanism | double-booked | 3 | inoperative 3/3 | 0/3 | prediction missed |
| `unique_constraint` | deadlock-pairs | Mechanism | double-booked | 3 | inoperative 3/3 | 0/90 | prediction missed |
| `pessimistic` | hammer-seat | Mechanism | held | 3 | held 3/3 | 3/3 | as predicted |
| `pessimistic` | deadlock-pairs | Mechanism | held | 3 | held 3/3 | 90/90 | as predicted |
| `optimistic` | hammer-seat | Mechanism | held | 3 | held 3/3 | 3/3 | as predicted |
| `optimistic` | deadlock-pairs | Mechanism | held | 3 | held 3/3 | 90/90 | as predicted |
| `advisory` | hammer-seat | Mechanism | held | 3 | held 3/3 | 3/3 | as predicted |
| `advisory` | deadlock-pairs | Mechanism | held | 3 | held 3/3 | 89/90 | as predicted |
| `serializable` | hammer-seat | Mechanism | held | 3 | held 3/3 | 3/3 | as predicted |
| `serializable` | deadlock-pairs | Mechanism | held | 3 | held 3/3 | 53/90 | as predicted |

### `unique_constraint`: prediction missed — it fails closed instead of double-booking

The prediction was that `unique_constraint` would double-book, on the reasoning that a conflict-ignoring insert with no unique index never
conflicts. That is true of a target-less `ON CONFLICT DO NOTHING`. The code's insert names its conflict target (`ON CONFLICT (seat_id) DO NOTHING`), and
Postgres needs a unique index to arbitrate that. The reports record the application's own error, 720 times across these runs: `error: there is no unique or exclusion constraint matching the ON CONFLICT specification`.
The Mechanism **fails closed**: it books nothing rather than booking twice. The failure is answered as an unclassified HTTP 500 (not one of the designed outcomes, ADR-0025), which matters only because this is not a configuration the system ships. The conclusion the prediction was
after (it cannot stand alone) is right; the way it fails is not what was predicted. The Oracles pass here only because the database is empty, which is why
the verdict has a category for it.

### Underfilled runs: held, but not fully served

4 run(s) kept every Oracle green yet created fewer Bookings than a fully served run:
- `advisory`: `pg_try_advisory_xact_lock` is non-blocking (ADR-0006) and can refuse both requests of a pair; the key replay that follows each run then books the missing pair
- `serializable`: retry exhaustion answers HTTP 503 and books nothing (ADR-0012, ADR-0013)

Where an explanation is given it is inferred from the Mechanism's design and the status tallies, not isolated by a separate with-Backstop run. None of this is a safety
failure; it is reported so "held" is not read as "fully served".

## Why 60 concurrent, not 1,000

The spec asked for 1,000 concurrent single-seat requests. The chaos harness could not carry that on this machine. One probe, on the Control only, at
1000 requests (`w1-smoke-probe-1000-naive-hammer-seat-2026-11-26T03-44-52-078Z.json`) had **606 of 1000** requests reset at the connection level
(no HTTP answer), so only 394 reached the application, and the Control created 3 Booking(s) on the one seat
where the 60-request runs created 4–17. That is consistent with the macOS listen backlog (`kern.ipc.somaxconn` read as
128 on the machine that ran this; the report does not record it). A verdict of "held" under that noise would be weaker evidence, not stronger. The measured matrix
therefore stays at the ceiling the project's other chaos matrices use (Exhibit H), and the detector check above is the evidence that this level is enough to
expose a double-booking. No level between 60 and 1,000 was tried. Exhibits B and C carry the 1,000-concurrent evidence, with the Backstop in place.

## Smoke runs

Before any measured run, one run of each strategy and workload confirmed it starts and books normally on the Backstop-free database, so that a setup
problem could not be mistaken for a result. Smoke reports are kept but never counted as measured repeats.

| Run | Mechanism or Control | Workload | HTTP statuses | Bookings created | Oracles | Verdict | Report |
|---|---|---|---|---|---|---|---|
| w1-smoke-advisory-deadlock-pairs | `advisory` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-smoke-advisory-deadlock-pairs-2026-11-26T03-44-22-435Z.json](exhibit-i/w1-smoke-advisory-deadlock-pairs-2026-11-26T03-44-22-435Z.json) |
| w1-smoke-advisory-hammer-seat | `advisory` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-smoke-advisory-hammer-seat-2026-11-26T03-44-02-992Z.json](exhibit-i/w1-smoke-advisory-hammer-seat-2026-11-26T03-44-02-992Z.json) |
| w1-smoke-naive-deadlock-pairs | `naive` | deadlock-pairs | 53x 201, 7x 409 | 53 | 1✗ 2✓ 3✓ 4✓ | double-booked | [w1-smoke-naive-deadlock-pairs-2026-11-26T03-44-09-468Z.json](exhibit-i/w1-smoke-naive-deadlock-pairs-2026-11-26T03-44-09-468Z.json) |
| w1-smoke-naive-hammer-seat | `naive` | hammer-seat | 9x 201, 51x 409 | 9 | 1✗ 2✓ 3✓ 4✓ | double-booked | [w1-smoke-naive-hammer-seat-2026-11-26T03-43-53-155Z.json](exhibit-i/w1-smoke-naive-hammer-seat-2026-11-26T03-43-53-155Z.json) |
| w1-smoke-optimistic-deadlock-pairs | `optimistic` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-smoke-optimistic-deadlock-pairs-2026-11-26T03-44-19-192Z.json](exhibit-i/w1-smoke-optimistic-deadlock-pairs-2026-11-26T03-44-19-192Z.json) |
| w1-smoke-optimistic-hammer-seat | `optimistic` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-smoke-optimistic-hammer-seat-2026-11-26T03-43-59-703Z.json](exhibit-i/w1-smoke-optimistic-hammer-seat-2026-11-26T03-43-59-703Z.json) |
| w1-smoke-pessimistic-deadlock-pairs | `pessimistic` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-smoke-pessimistic-deadlock-pairs-2026-11-26T03-44-15-935Z.json](exhibit-i/w1-smoke-pessimistic-deadlock-pairs-2026-11-26T03-44-15-935Z.json) |
| w1-smoke-pessimistic-hammer-seat | `pessimistic` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-smoke-pessimistic-hammer-seat-2026-11-26T03-43-56-420Z.json](exhibit-i/w1-smoke-pessimistic-hammer-seat-2026-11-26T03-43-56-420Z.json) |
| w1-smoke-serializable-deadlock-pairs | `serializable` | deadlock-pairs | 17x 201, 14x 409, 29x 503 | 17 | 1✓ 2✓ 3✓ 4✓ | held | [w1-smoke-serializable-deadlock-pairs-2026-11-26T03-44-25-695Z.json](exhibit-i/w1-smoke-serializable-deadlock-pairs-2026-11-26T03-44-25-695Z.json) |
| w1-smoke-serializable-hammer-seat | `serializable` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-smoke-serializable-hammer-seat-2026-11-26T03-44-06-202Z.json](exhibit-i/w1-smoke-serializable-hammer-seat-2026-11-26T03-44-06-202Z.json) |
| w1-smoke-unique_constraint-deadlock-pairs | `unique_constraint` | deadlock-pairs | 60x 500 | 0 | 1✓ 2✓ 3✓ 4✓ | inoperative | [w1-smoke-unique_constraint-deadlock-pairs-2026-11-26T03-44-12-731Z.json](exhibit-i/w1-smoke-unique_constraint-deadlock-pairs-2026-11-26T03-44-12-731Z.json) |
| w1-smoke-unique_constraint-hammer-seat | `unique_constraint` | hammer-seat | 60x 500 | 0 | 1✓ 2✓ 3✓ 4✓ | inoperative | [w1-smoke-unique_constraint-hammer-seat-2026-11-26T03-40-44-886Z.json](exhibit-i/w1-smoke-unique_constraint-hammer-seat-2026-11-26T03-40-44-886Z.json) |

## What this does and does not show

**Shows.** On a database without the Backstop, at this load, 24 of 24 runs of the four coordinated Mechanisms never claimed a Seat twice and never tore a Booking, while the Control did in 6 of 6. Their own coordination step, not the Backstop, is what they rely on. The unique-constraint Mechanism, by construction, relies on nothing else.

**Does not show.**

- *Not a proof.* 3 repeats of 60 requests are evidence at this load, not a guarantee; the formal track (Exhibit G) is where "holds in all interleavings" is checked, for the modelled protocol.
- *Concurrency below the spec's 1,000.* Single-seat contention ran at 60, because the chaos harness could not carry 1,000 here (one probe, on the Control only; no level in between was tried).
- *Not the production configuration.* Production keeps the Backstop. A Mechanism that fails here is not failing there; one that holds here has independent protection in addition to it.
- *Not a performance comparison.* Latency and throughput are Exhibit C's, with the Backstop in place.
- *Not Faults.* No Fault was injected (Exhibit H covers those, with the Backstop in place).
- *Not the hold/confirm flow.* Only booking claims were exercised.
- *One machine, containerized Postgres, one app process.*

## Decision record

No ADR was written for this exhibit. Nothing in it is hard to reverse (a new exhibit, a harness flag and a driver), and its result is a measurement, not a choice between alternatives;
what it means for the recommendation belongs to the recommendation-matrix ticket (#75) and the writeup (#76).

## All runs

| Run | Mechanism or Control | Workload | HTTP statuses | Bookings created | Oracles | Verdict | Report |
|---|---|---|---|---|---|---|---|
| w1-advisory-deadlock-pairs-rep1 | `advisory` | deadlock-pairs | 29x 201, 31x 409 | 29 | 1✓ 2✓ 3✓ 4✓ | held | [w1-advisory-deadlock-pairs-rep1-2026-11-26T03-45-47-587Z.json](exhibit-i/w1-advisory-deadlock-pairs-rep1-2026-11-26T03-45-47-587Z.json) |
| w1-advisory-deadlock-pairs-rep2 | `advisory` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-advisory-deadlock-pairs-rep2-2026-11-26T03-46-26-374Z.json](exhibit-i/w1-advisory-deadlock-pairs-rep2-2026-11-26T03-46-26-374Z.json) |
| w1-advisory-deadlock-pairs-rep3 | `advisory` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-advisory-deadlock-pairs-rep3-2026-11-26T03-47-05-072Z.json](exhibit-i/w1-advisory-deadlock-pairs-rep3-2026-11-26T03-47-05-072Z.json) |
| w1-advisory-hammer-seat-rep1 | `advisory` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-advisory-hammer-seat-rep1-2026-11-26T03-45-28-264Z.json](exhibit-i/w1-advisory-hammer-seat-rep1-2026-11-26T03-45-28-264Z.json) |
| w1-advisory-hammer-seat-rep2 | `advisory` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-advisory-hammer-seat-rep2-2026-11-26T03-46-06-976Z.json](exhibit-i/w1-advisory-hammer-seat-rep2-2026-11-26T03-46-06-976Z.json) |
| w1-advisory-hammer-seat-rep3 | `advisory` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-advisory-hammer-seat-rep3-2026-11-26T03-46-45-744Z.json](exhibit-i/w1-advisory-hammer-seat-rep3-2026-11-26T03-46-45-744Z.json) |
| w1-naive-deadlock-pairs-rep1 | `naive` | deadlock-pairs | 58x 201, 2x 409 | 58 | 1✗ 2✓ 3✓ 4✓ | double-booked | [w1-naive-deadlock-pairs-rep1-2026-11-26T03-45-34-710Z.json](exhibit-i/w1-naive-deadlock-pairs-rep1-2026-11-26T03-45-34-710Z.json) |
| w1-naive-deadlock-pairs-rep2 | `naive` | deadlock-pairs | 48x 201, 12x 409 | 48 | 1✗ 2✓ 3✓ 4✓ | double-booked | [w1-naive-deadlock-pairs-rep2-2026-11-26T03-46-13-423Z.json](exhibit-i/w1-naive-deadlock-pairs-rep2-2026-11-26T03-46-13-423Z.json) |
| w1-naive-deadlock-pairs-rep3 | `naive` | deadlock-pairs | 39x 201, 21x 409 | 39 | 1✗ 2✓ 3✓ 4✓ | double-booked | [w1-naive-deadlock-pairs-rep3-2026-11-26T03-46-52-170Z.json](exhibit-i/w1-naive-deadlock-pairs-rep3-2026-11-26T03-46-52-170Z.json) |
| w1-naive-hammer-seat-rep1 | `naive` | hammer-seat | 17x 201, 43x 409 | 17 | 1✗ 2✓ 3✓ 4✓ | double-booked | [w1-naive-hammer-seat-rep1-2026-11-26T03-45-15-192Z.json](exhibit-i/w1-naive-hammer-seat-rep1-2026-11-26T03-45-15-192Z.json) |
| w1-naive-hammer-seat-rep2 | `naive` | hammer-seat | 4x 201, 56x 409 | 4 | 1✗ 2✓ 3✓ 4✓ | double-booked | [w1-naive-hammer-seat-rep2-2026-11-26T03-45-54-121Z.json](exhibit-i/w1-naive-hammer-seat-rep2-2026-11-26T03-45-54-121Z.json) |
| w1-naive-hammer-seat-rep3 | `naive` | hammer-seat | 4x 201, 56x 409 | 4 | 1✗ 2✓ 3✓ 4✓ | double-booked | [w1-naive-hammer-seat-rep3-2026-11-26T03-46-32-936Z.json](exhibit-i/w1-naive-hammer-seat-rep3-2026-11-26T03-46-32-936Z.json) |
| w1-optimistic-deadlock-pairs-rep1 | `optimistic` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-optimistic-deadlock-pairs-rep1-2026-11-26T03-45-44-329Z.json](exhibit-i/w1-optimistic-deadlock-pairs-rep1-2026-11-26T03-45-44-329Z.json) |
| w1-optimistic-deadlock-pairs-rep2 | `optimistic` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-optimistic-deadlock-pairs-rep2-2026-11-26T03-46-23-120Z.json](exhibit-i/w1-optimistic-deadlock-pairs-rep2-2026-11-26T03-46-23-120Z.json) |
| w1-optimistic-deadlock-pairs-rep3 | `optimistic` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-optimistic-deadlock-pairs-rep3-2026-11-26T03-47-01-836Z.json](exhibit-i/w1-optimistic-deadlock-pairs-rep3-2026-11-26T03-47-01-836Z.json) |
| w1-optimistic-hammer-seat-rep1 | `optimistic` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-optimistic-hammer-seat-rep1-2026-11-26T03-45-25-066Z.json](exhibit-i/w1-optimistic-hammer-seat-rep1-2026-11-26T03-45-25-066Z.json) |
| w1-optimistic-hammer-seat-rep2 | `optimistic` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-optimistic-hammer-seat-rep2-2026-11-26T03-46-03-751Z.json](exhibit-i/w1-optimistic-hammer-seat-rep2-2026-11-26T03-46-03-751Z.json) |
| w1-optimistic-hammer-seat-rep3 | `optimistic` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-optimistic-hammer-seat-rep3-2026-11-26T03-46-42-526Z.json](exhibit-i/w1-optimistic-hammer-seat-rep3-2026-11-26T03-46-42-526Z.json) |
| w1-pessimistic-deadlock-pairs-rep1 | `pessimistic` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-pessimistic-deadlock-pairs-rep1-2026-11-26T03-45-41-120Z.json](exhibit-i/w1-pessimistic-deadlock-pairs-rep1-2026-11-26T03-45-41-120Z.json) |
| w1-pessimistic-deadlock-pairs-rep2 | `pessimistic` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-pessimistic-deadlock-pairs-rep2-2026-11-26T03-46-19-820Z.json](exhibit-i/w1-pessimistic-deadlock-pairs-rep2-2026-11-26T03-46-19-820Z.json) |
| w1-pessimistic-deadlock-pairs-rep3 | `pessimistic` | deadlock-pairs | 30x 201, 30x 409 | 30 | 1✓ 2✓ 3✓ 4✓ | held | [w1-pessimistic-deadlock-pairs-rep3-2026-11-26T03-46-58-635Z.json](exhibit-i/w1-pessimistic-deadlock-pairs-rep3-2026-11-26T03-46-58-635Z.json) |
| w1-pessimistic-hammer-seat-rep1 | `pessimistic` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-pessimistic-hammer-seat-rep1-2026-11-26T03-45-21-795Z.json](exhibit-i/w1-pessimistic-hammer-seat-rep1-2026-11-26T03-45-21-795Z.json) |
| w1-pessimistic-hammer-seat-rep2 | `pessimistic` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-pessimistic-hammer-seat-rep2-2026-11-26T03-46-00-505Z.json](exhibit-i/w1-pessimistic-hammer-seat-rep2-2026-11-26T03-46-00-505Z.json) |
| w1-pessimistic-hammer-seat-rep3 | `pessimistic` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-pessimistic-hammer-seat-rep3-2026-11-26T03-46-39-288Z.json](exhibit-i/w1-pessimistic-hammer-seat-rep3-2026-11-26T03-46-39-288Z.json) |
| w1-serializable-deadlock-pairs-rep1 | `serializable` | deadlock-pairs | 18x 201, 13x 409, 29x 503 | 18 | 1✓ 2✓ 3✓ 4✓ | held | [w1-serializable-deadlock-pairs-rep1-2026-11-26T03-45-50-768Z.json](exhibit-i/w1-serializable-deadlock-pairs-rep1-2026-11-26T03-45-50-768Z.json) |
| w1-serializable-deadlock-pairs-rep2 | `serializable` | deadlock-pairs | 18x 201, 14x 409, 28x 503 | 18 | 1✓ 2✓ 3✓ 4✓ | held | [w1-serializable-deadlock-pairs-rep2-2026-11-26T03-46-29-595Z.json](exhibit-i/w1-serializable-deadlock-pairs-rep2-2026-11-26T03-46-29-595Z.json) |
| w1-serializable-deadlock-pairs-rep3 | `serializable` | deadlock-pairs | 17x 201, 12x 409, 31x 503 | 17 | 1✓ 2✓ 3✓ 4✓ | held | [w1-serializable-deadlock-pairs-rep3-2026-11-26T03-47-08-352Z.json](exhibit-i/w1-serializable-deadlock-pairs-rep3-2026-11-26T03-47-08-352Z.json) |
| w1-serializable-hammer-seat-rep1 | `serializable` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-serializable-hammer-seat-rep1-2026-11-26T03-45-31-471Z.json](exhibit-i/w1-serializable-hammer-seat-rep1-2026-11-26T03-45-31-471Z.json) |
| w1-serializable-hammer-seat-rep2 | `serializable` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-serializable-hammer-seat-rep2-2026-11-26T03-46-10-199Z.json](exhibit-i/w1-serializable-hammer-seat-rep2-2026-11-26T03-46-10-199Z.json) |
| w1-serializable-hammer-seat-rep3 | `serializable` | hammer-seat | 1x 201, 59x 409 | 1 | 1✓ 2✓ 3✓ 4✓ | held | [w1-serializable-hammer-seat-rep3-2026-11-26T03-46-48-981Z.json](exhibit-i/w1-serializable-hammer-seat-rep3-2026-11-26T03-46-48-981Z.json) |
| w1-unique_constraint-deadlock-pairs-rep1 | `unique_constraint` | deadlock-pairs | 60x 500 | 0 | 1✓ 2✓ 3✓ 4✓ | inoperative | [w1-unique_constraint-deadlock-pairs-rep1-2026-11-26T03-45-37-909Z.json](exhibit-i/w1-unique_constraint-deadlock-pairs-rep1-2026-11-26T03-45-37-909Z.json) |
| w1-unique_constraint-deadlock-pairs-rep2 | `unique_constraint` | deadlock-pairs | 60x 500 | 0 | 1✓ 2✓ 3✓ 4✓ | inoperative | [w1-unique_constraint-deadlock-pairs-rep2-2026-11-26T03-46-16-620Z.json](exhibit-i/w1-unique_constraint-deadlock-pairs-rep2-2026-11-26T03-46-16-620Z.json) |
| w1-unique_constraint-deadlock-pairs-rep3 | `unique_constraint` | deadlock-pairs | 60x 500 | 0 | 1✓ 2✓ 3✓ 4✓ | inoperative | [w1-unique_constraint-deadlock-pairs-rep3-2026-11-26T03-46-55-366Z.json](exhibit-i/w1-unique_constraint-deadlock-pairs-rep3-2026-11-26T03-46-55-366Z.json) |
| w1-unique_constraint-hammer-seat-rep1 | `unique_constraint` | hammer-seat | 60x 500 | 0 | 1✓ 2✓ 3✓ 4✓ | inoperative | [w1-unique_constraint-hammer-seat-rep1-2026-11-26T03-45-18-502Z.json](exhibit-i/w1-unique_constraint-hammer-seat-rep1-2026-11-26T03-45-18-502Z.json) |
| w1-unique_constraint-hammer-seat-rep2 | `unique_constraint` | hammer-seat | 60x 500 | 0 | 1✓ 2✓ 3✓ 4✓ | inoperative | [w1-unique_constraint-hammer-seat-rep2-2026-11-26T03-45-57-305Z.json](exhibit-i/w1-unique_constraint-hammer-seat-rep2-2026-11-26T03-45-57-305Z.json) |
| w1-unique_constraint-hammer-seat-rep3 | `unique_constraint` | hammer-seat | 60x 500 | 0 | 1✓ 2✓ 3✓ 4✓ | inoperative | [w1-unique_constraint-hammer-seat-rep3-2026-11-26T03-46-36-121Z.json](exhibit-i/w1-unique_constraint-hammer-seat-rep3-2026-11-26T03-46-36-121Z.json) |
