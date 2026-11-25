---
status: accepted
---

# `serializable`'s retry loop gets a time budget; `optimistic`'s slow-link cost is accepted, not fixed

Finding R6 (issue #59, Exhibit H): with only 100 ms added per protocol chunk (the `latency-below` Fault, client timeout T = 5 s, so the other four mechanisms never time out), `optimistic` × `hammer-seat` timed out 130 of 300 clients over 5 reps and `serializable` × `deadlock-pairs` timed out 37 and answered 206 × `503`. The ticket's hypothesis was that retry loops multiply per-round-trip latency. Re-measuring on `main` with R1–R4 merged and probing each request's `X-Booking-Retries` header split the finding in two, because the hypothesis is true for one mechanism and false for the other.

## What was measured

All numbers are in Exhibit H section J (reports `docs/evidence/chaos/r6-*.json`; probe output `docs/evidence/chaos/r6-probe-results.txt`, produced by `load-harness/chaos/probe-retry-latency.ts`, which reads the retry header a chaos report does not carry). Unmodified application, no `--survive-uncaught`, all Oracles green in every run, 0 Correctness violations.

**`optimistic` × `hammer-seat`, 3 reps on current `main`: 0 client timeouts, 48 × `504` + 11 × `409` + 1 × `201` in every run, slowest request 2.6–2.7 s.** R4 (ADR-0026) already changed the shape: the 26 requests per run that used to hit the client's 5 s are now cut off by `statement_timeout` (1.5 s) *while waiting for the winner's row lock* and answered `504`. And the retry loop is not involved: **every one of the 12 responses that was not a `504` carried `X-Booking-Retries: 0`** (probe at 20, 50 and 100 ms/chunk). A hammer-seat loser's CAS misses, its one extra `readSeats` finds the seat `booked`, and it returns `409` without a retry (ADR-0009: a retry is only for the cancellation race). What is slow is waiting in line for one row lock: with the three database bounds raised to 20 s, the same 60 requests all complete (`409` × 59, `201` × 1, retries 0) but take **7.7 s against `naive`'s 1.2 s** at 100 ms/chunk. The reason `optimistic` queues so much longer than `naive` was not established and is not claimed here; the winner holds the seat's row lock across more round trips (its CAS comes first, then `RELEASE SAVEPOINT`, two `INSERT`s and `COMMIT`, whereas `naive` and `unique_constraint` claim through an uncommitted unique-index entry that is held for two round trips), which is consistent with the numbers but was not isolated.

**`serializable` × `deadlock-pairs`: the loop is the problem.** Per-request retries are 5 (the cap) for 18–19 of 30 requests at 20 ms/chunk already, and 1–2 `503`s of 30 even with no added latency; every pair's two requests retry in lockstep, and the 1–5 ms backoff jitter (ADR-0011) is 40–200× smaller than a round trip, so retrying does not separate them. With five retries each costing a whole transaction's round trips, a request runs for `6 × attempt` and R4's per-statement bounds never fire, because no single statement is slow:

| ms added per chunk | no time budget (probe, 30 requests): unanswered at the client's 5 s | 503 / 409 / 201 | slowest request |
|---|---|---|---|
| 20 | 0 of 30 | 18 / 6 / 6 | 1.2 s |
| 50 | 0 of 30 | 19 / 5 / 6 | 2.6 s |
| 100 | 0 of 30 (the 3 harness reps of 60: 0, 11 and 0) | 18 / 6 / 6 | 5.0 s |
| 125 | **22 of 30** (the 3 harness reps of 60: 52, 51, 51) | 0 / 4 / 4 | 5.0 s (client) |
| 150 | **23 of 30** | 0 / 3 / 4 | 5.0 s (client) |
| 200 | **25 of 30** | 0 / 2 / 3 | 5.0 s (client) |

The 100 ms row is the ticket's cell: the 503s are answered at 4.97–4.99 s, 10–30 ms inside the client's timeout, which is why 11 clients lost the race in one rep. A link only 25% slower turns nearly every request into a client timeout, which is an Ambiguous outcome for the client where a `503` would have been an answer. R4's own ADR says so ("a request that retries on every attempt can still run for several bounds' worth of time. That is R6").

## Decision

### 1. `serializable`: a time budget on the retry loop, alongside the count cap

`withSerializableTransaction` (`src/db/pool.ts`) stops starting attempts once another one is predicted to finish past `RETRY_BUDGET_MS` (default **3000**, `{ min: 1 }`, `src/config.ts`). Implemented in `src/db/retryBudget.ts`:

- The clock starts when the loop is entered (after the pool checkout and the idempotency lookup), and is checked only **after a retriable failure** (`40001` or `40P01`), at the same place as the count cap.
- The prediction is the failed attempt's own duration: stop when `elapsed + lastAttempt > budget`. The total therefore stays near the budget instead of overshooting it by a whole attempt, and no assumption about the link's speed is built in. The first attempt is never refused.
- **At exhaustion** the loop throws the same `SerializationRetriesExhaustedError(retries)` the count cap throws, so the request ends exactly as before: `retry_exhausted`, HTTP `503`, `X-Booking-Retries` = retries actually made (ADR-0012). `retry_exhausted` already means "the mechanism ran and could not resolve contention *in time*"; a time cap is that sentence taken literally, so no new result kind, status or client contract is introduced. Either cap can end the loop; the response does not say which.

Why this is coherent with R4 and not a second competing mechanism: ADR-0026's bounds are per statement and per idle gap and still own every wait *inside* an attempt; the budget never interrupts an attempt or a statement, it only declines to start another. ADR-0026 explicitly left "a deadline across a whole request ... [that] would also have to cut into the retry loops" to this ticket; this is that, scoped to the one loop where the evidence shows the loop is the cost. The default is ADR-0026's server-side worst case for a stalled transaction (statement + idle bound = 3 s), so the two time limits agree, and a request ends about one retry-decision after it: measured p95 3.4 s, under the 5 s client timeout the chaos harness uses. A deployment with a different slowest client timeout tunes `RETRY_BUDGET_MS` with the four ADR-0026 variables; the constraint is `budget + one attempt + connection setup < the client timeout`.

Measured, same cell, 5 reps, unmodified code, all Oracles green: client timeouts 0 (before, on `main`: 0, 11, 0), slowest request **3.4–3.5 s** (before: 5.0 s), and the cost, stated plainly: **fewer requests complete** (`201` + `409` per run: 7 of 60 against 11; `503`: 53 of 60 against 49 in the two reps that had no client timeouts), because fewer retries means fewer chances to win one. At 125 ms/chunk (3 reps each, same binary, only `RETRY_BUDGET_MS` differs): **51–52 of 60 clients timed out without the budget, 0 with it**, all 54 non-winners answered `503` at 3.4 s. The budget does not fix the lockstep retry collisions behind the high `503` rate; it bounds how long the client waits for the answer.

No regression under normal load: `serializable` × `hammer-seat` at the acceptance concurrency (100), 5 repeats, no Fault: 0 `503`, 0 other, p99 37–67 ms, no double-booking (Exhibit H J5). A fast link's attempts last milliseconds, so a 3 s budget cannot fire there; Exhibit C's `0.0%` retry-exhaustion column is not invalidated, and it now carries a note that it is a property of a fast link.

### 2. `optimistic`: accepted, no code change

- **The retry loop is not what costs the time**, so bounding it in time would change nothing: its CAS loop did not run in a single hammer-seat response (retries 0). The cancellation-race retry it exists for (ADR-0009: capped at 3, no backoff, only on a rare race) is not the observed workload.
- **R4 already bounds the request** at about 2.5 s, as an answered `504` carrying ADR-0025/0026's "outcome unknown, retry with the same key" contract, not as a client timeout. Raising `statement_timeout` would show 59 answered `409`s but after 7.7 s, which is worse.
- **Fewer round trips per retry** is constrained by ADR-0009 (the second `readSeats` is the correctness mechanism that tells a conflict from a concurrent cancellation) and was already the conclusion of issue #36 (Exhibit E): the extra cost belongs to the CAS-retry design this project set out to compare against locking. Moving the CAS after the booking `INSERT`s would shorten the lock-hold, but then the `booking_seats` unique index, not the version column, decides who wins, which is a different mechanism (ADR-0013's lesson about `serializable`) and would change what Exhibit C measures for `optimistic`.

The trade-off is written where a reader compares mechanisms: Exhibit C's "Reading the columns" (retry-exhaustion bullet), Exhibit E's `optimistic` section, and Exhibit H section J.

## Not adopted

- **A time budget on `optimistic`'s CAS loop or on `withDeadlockRetry`** (used by `naive`, `unique_constraint`, `optimistic`'s multi-seat path). No cell shows either looping under a slow link: the other mechanisms in the same two cells ran with 0 client timeouts and no retries (Exhibit H J4), and with `seat_ids` sorted (ADR-0014) a `40P01` is the exception. Adding a budget there would be code with no observed effect.
- **Scaling the jitter with the observed attempt time.** It would address the lockstep collisions behind the `503` rate rather than only bounding the wait, but it changes ADR-0011's retry policy and what Exhibit C's `serializable` latency numbers mean, and nothing here shows the policy is wrong on a normal link. Left as a possible later experiment.
- **A request-level deadline across the whole handler.** Every other wait is already bounded per statement (ADR-0026) and a request is a short fixed sequence of statements; the retry loop was the only place those bounds multiply.

## Consequences

- New env var `RETRY_BUDGET_MS` (default 3000, validated at startup like the ADR-0026 variables).
- `503 retry_exhausted` can now arrive before the count cap is spent, under a slow link: its `X-Booking-Retries` may be below 5 (0–3 in the probes at 100–200 ms).
- `src/db/pool.ts` gains two lines above the Exhibit G pinned anchors (an import and one `const`); with R4's earlier two the mapping drift test (`test/formalMapping.test.ts`) is at its tolerance of 4 lines for the serializable-retry and deadlock-fallback rows. The next change above them in that file must re-pin those rows in Exhibit G.
- `optimistic` still answers `504` for most clients of a hot seat on a slow link; this is documented, not changed.
