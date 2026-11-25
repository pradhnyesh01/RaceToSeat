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

Phase 5 (realistic hold → confirm → expire booking flow, stretch) has begun, scoped down to
`pessimistic` only rather than all six mechanisms (ADR-0017) — a design decision reached
through a structured grilling session and recorded across four ADRs (0017-0020) and two
`CONTEXT.md` glossary entries (`Confirm`, `Reaper`) before implementation started, then broken
into four tracer-bullet tickets (issues #38-#41, `1 → {2, 3} → 4`). Issue #38 ships the first:
hold creation. New `holds`/`hold_seats` tables (`db/schema.sql`) mirror `bookings`/
`booking_seats`, activating the `seats.held_until`/`booked_by` columns reserved since Phase 0.
`POST /holds` is implemented in `src/strategies/pessimisticHold.ts`, mirroring
`bookSeatPessimistic`'s `FOR UPDATE NOWAIT` acquisition/fallback-existence-check shape exactly
— same "exactly one winner" guarantee a booking gets, same all-or-nothing multi-seat atomicity,
same `holds.idempotency_key UNIQUE` dedupe pattern as `bookings.idempotency_key` (new helpers in
`src/strategies/idempotency.ts`: `findExistingHoldByIdempotencyKey`, `resolveHoldIdempotencyKeyRace`,
`runTransactionalHold`). The route (`src/routes/holds.ts`) and its not-yet-built confirm sibling
are gated by `BOOKING_STRATEGY=pessimistic` at the `createApp()` composition root (ADR-0019) —
the first strategy-gated routes in the app, 404 under any other configured mechanism. TTL is a
fixed server-side constant (`config.holdTtlSeconds`, default 300s, `HOLD_TTL_SECONDS` env
override only — never a per-request field). A code-review pass on this ticket caught and fixed
one real bug before merge: `HOLD_TTL_SECONDS` had no positivity check, so a zero/negative
override silently produced a hold whose `held_until` was already in the past — `config.ts`'s
`intEnv` now takes an optional `min` bound, `holdTtlSeconds` passes `{ min: 1 }`, and the failure
is now a startup-time throw instead of a dead-on-arrival hold (regression-tested in
`test/config.test.ts`). The same pass also deduplicated the request-body validation shared
between `POST /bookings` and `POST /holds` into `src/routes/validation.ts`, and the `FOR UPDATE`
test helper shared between `pessimistic.test.ts` and the new `pessimisticHold.test.ts` into
`test/testDb.ts`. Confirm (issue #39) and the reaper (issue #40) are not yet implemented — a
seat that enters `'held'` via this ticket currently has no path back to `'available'` or forward
to `'booked'`, expected and tracked, not a defect in this ticket's own scope. Full test suite
passes (134 tests, up from 118) and `npm run typecheck` is clean.

Issue #39 ships confirm: `POST /holds/{id}/confirm` converts a live hold into a real booking. It's
bodyless — the hold id in the URL path is the sole capability, no ownership check, mirroring
`DELETE /bookings/{id}`'s existing precedent — and reuses a new shared booking-creation-tail
helper, `insertBookingForSeats` (`src/strategies/idempotency.ts`), factored out of
`pessimistic.ts`'s existing `POST /bookings` write path rather than duplicated (that refactor is
behavior-preserving: same three statements, same columns, only addition is an unconditional
`held_until = NULL`, a no-op for the booking path but load-bearing for confirm's). Implemented in
`src/strategies/pessimisticConfirm.ts`: `hold_seats` and `seats` are read and locked in one atomic
`JOIN ... FOR UPDATE OF s NOWAIT` statement (not two separate queries — see below for why that
matters), `bookings.idempotency_key` for the resulting row is synthesized from the hold's id
(prefixed `hold-confirm:<id>`, not the raw id — see below), and the result maps to `201`
(created/idempotent-replay), `410` (expired — checked by confirm itself as a lazy backstop
independent of the not-yet-built reaper, ADR-0018), `409` (lost the row lock to a genuinely
concurrent confirm, reusing `pessimistic.ts`'s NOWAIT-conflict translation), or `404`
(unknown/malformed/already-resolved hold id, matching `DELETE /bookings/{id}`'s malformed-id
handling). A code-review pass caught two real bugs before merge, both found independently by two
of the eight review angles each: (1) the original design read `hold_seats` and locked `seats` as
two separate round-trip queries, leaving a real gap for a concurrent confirm on the same hold to
fully commit in between — the loser's now-uncontested `NOWAIT` lock would then succeed and read
the seat as already `'booked'`, misreporting `410 Gone` instead of replaying the winner's booking;
fixed at the root by combining both reads into one atomic statement (a defensive
status-isn't-`'held'` fallback stayed in as extra insurance) rather than patching around it. (2)
The synthesized idempotency key was the hold's raw id with no namespace, sharing one flat
`TEXT` column with whatever arbitrary string a client passes to `POST /bookings` directly (no
format validation exists) — a client setting `idempotency_key` to another user's outstanding hold
id could hijack that hold's later confirm into replaying an unrelated booking, permanently
stranding the real held seats; fixed by prefixing the synthesized key, proven by a new regression
test that seeds a colliding direct booking first. The same pass also combined two sequential
`DELETE`s into one CTE, removed a redundant per-seat `held_until` re-check (it's hold-uniform,
same as `booked_by`), and dropped an unneeded `normalizeSeatIds` call on already-normalized
values. Full test suite passes (144 tests, up from 134) and `npm run typecheck` is clean.

Issue #40 ships the reaper, closing out Phase 5's `1 → {2, 3} → 4` tracer-bullet sequence's last
gap: a seat whose hold expires without ever being confirmed now has an automatic path back to
`'available'`. `src/reaper.ts` exports `runReaperSweep(pool)` — one atomic, chained-CTE SQL
statement (reset expired seats → delete their `hold_seats` rows → delete the now-empty `holds`
rows), deliberately not three separate statements: each CTE's own `WHERE`/join is the actual
check, so Postgres's normal EvalPlanQual re-check semantics protect it from the "precomputed stale
id list" trap a naive read-then-write split would fall into under concurrent access from a racing
`confirm` — and `startReaper(pool, intervalMs)`, a thin `setInterval` wrapper with a `stop()`
handle, wired into `src/server.ts` only (not `createApp()`, which the test suite calls repeatedly
and would otherwise leak real timers across files) and started only after `app.listen` confirms
its port bind succeeded. Postgres-only, no Redis, per ADR-0018. A code-review pass caught and
fixed six things before merge, none of them correctness-critical on their own (the cross-file
tracer angle worked the reaper/confirm race by hand and confirmed no double-write is reachable)
but each worth closing: (1) no index backed the sweep's `WHERE status = 'held' AND held_until <
now()`, so every 5-second tick did a full `seats` table scan — fixed with a partial index,
`seats_held_expiry_idx`, that only covers the currently-held subset; (2) `server.ts`'s shutdown
handler stopped the reaper but exited immediately without draining in-flight requests or closing
the pool, found independently by four review angles — fixed by awaiting `app.close()` then
`pool.end()` before exit, re-verified with a manual SIGTERM smoke test; (3) the
`BOOKING_STRATEGY=pessimistic` gate was duplicated as a literal comparison in both `app.ts` and
`server.ts` — extracted into one `strategySupportsHolds()` predicate in `config.ts`; (4) the
reaper was started before `app.listen`'s callback confirmed a successful port bind — moved inside
it; (5) `createHold`/`expireHold` test helpers were duplicated between `reaper.test.ts` and
`holdContract.ts` (the same duplication-at-two-occurrences pattern already fixed once for
`withHeldRowLock` in issue #38's review) — extracted into `test/testDb.ts`, used by both; (6) no
test covered `REAPER_INTERVAL_MS`'s `min: 1` validation the way `HOLD_TTL_SECONDS`'s already was —
added, which surfaced a real gotcha along the way: a second dynamic `import("../src/config.js")`
in the same test file replays Node's cached rejection from the first import rather than
re-evaluating against the new env var, fixed with `vi.resetModules()`. Full test suite passes (150
tests, up from 144) and `npm run typecheck` is clean. Phase 5's foundation (issues #38-#40) is now
complete; issue #41 (the load-harness evidence run proving "no double-confirm, no permanently
stuck seats" under adversarial timing) is the last piece.

Issue #41 closes out Phase 5 with a fifth k6 load pattern, `hold-expiry-race.k6.js`
(`run.ts --pattern hold-expiry`), and a sixth exhibit doc. Unlike the other four patterns, it
seeds via the real HTTP API rather than raw SQL: it seeds `--concurrency` distinct seats, holds
every one of them through an actual `POST /holds` call (not a synthetic stand-in — the hold
flow's response shape only exists behind the HTTP API), waits until every seeded hold's own
`held_until` has passed, then fires two concurrent k6 scenarios at each one — 5 one-shot
`POST /holds/{id}/confirm` attempts per hold (one-shot deliberately: the claim under test is that
confirm *never* succeeds post-expiry, so retrying it would prove nothing extra), and 5 fresh
`POST /holds` attempts per seat, each retrying on `409` with a short sleep (a real client that
knows a hold is past TTL but still sees `409` would legitimately retry, since the only thing
standing between "expired" and "available" is the reaper's own sweep timer, not a permanent
condition). `--repeat` reseeds fresh seats/holds each attempt rather than resetting via an API
call, unlike the other four patterns — there's no hold-cancellation endpoint to reset an
already-raced seat back through, only confirm and reaper-driven expiry ever resolve a hold.
`aggregate.ts` gains a third `--exhibit` mode, `f`, reading these reports into
[docs/evidence/exhibit-f-phase5-hold-expiry.md](docs/evidence/exhibit-f-phase5-hold-expiry.md);
unlike Exhibit C/E's per-strategy matrices, this reads a single most-recent report, since only
`pessimistic` ever produces this pattern's reports (ADR-0017). Two ground-truth checks (not HTTP
status codes) drive the exhibit's pass/fail: zero bookings created via the synthesized
`hold-confirm:<id>` idempotency key for any hold this run seeded ("no late-succeeding confirms"),
and zero seats still `status = 'held'` with an expired `held_until` well after the run finished
("no permanently stuck seats") — both zero across 3 repeats × 200 seats in the measured run.
Getting a clean measurement took two rounds of self-correction, both caught by directly probing
the running server rather than trusting the first plausible-looking numbers: (1) the confirm
route is bodyless and the k6 script's first draft still sent a JSON `Content-Type` header with a
null body, which Fastify's parser rejects (`FST_ERR_CTP_EMPTY_JSON_BODY`) — every confirm attempt
came back as an uncategorized "other" status until the header was dropped; (2) an initial
timing choice (`FRESH_HOLD_MAX_ATTEMPTS` retry budget longer than `HOLD_TTL_SECONDS`) let a
winning fresh hold expire and get re-won by a still-retrying straggler before the k6 run ended,
producing a confusing second "winner" for a seat that was never actually double-held at any
single instant (not a correctness bug — `hold_seats.seat_id UNIQUE` and each acquisition's own
`FOR UPDATE NOWAIT` make concurrent double-holding structurally impossible — but noisy,
sequential-generations evidence); fixed by keeping three budgets cleanly nested,
`REAPER_INTERVAL_MS` < the fresh-hold retry budget < `HOLD_TTL_SECONDS` (measured run:
1000ms / ~3s / 8s), documented inline in both the k6 script and the exhibit's Method section.

A full 8-angle code-review pass (3 correctness + 3 cleanup + altitude + conventions, each
independently verified) confirmed 9 findings, all fixed before merge: (1) the "hold-confirm:<id>"
idempotency-key template the ground-truth "late confirm" query relies on was hand-copied into
`run.ts` instead of imported — `pessimisticConfirm.ts` now exports `confirmIdempotencyKey` for the
harness to reuse, so a future format change there can't silently desync the check into a false
PASS; (2) seeding N holds in sequential 50-at-a-time batches (`RESET_BATCH_SIZE`, tuned for
`resetSeatViaApi`'s DELETE reset, not for this timing-sensitive pattern) staggered their expiry
enough that the harness's own committed evidence showed 2 of 3 repeats' confirm attempts always
hitting an already-reaped hold (404), never a live-but-expired one (410) — the intended
"confirm races a still-present, expired hold" scenario was going untested in most repeats; fixed
with a dedicated, larger `HOLD_SEED_BATCH_SIZE` sized to fit this pattern's recommended
concurrency (≤200) in one batch; (3) the ground-truth "stuck seat" and "fresh-hold winner" queries
ran immediately after k6 exited, with no buffer against the independently-ticking reaper — a hold
expiring in the race's final moments could read as a false-positive stuck seat or an undercounted
winner purely from checking too early; fixed with a short grace sleep before both queries; (4) the
`BOOKING_STRATEGY=pessimistic` gate was reimplemented inline instead of reusing `strategySupportsHolds()`
from `config.ts` (extracted in issue #40's own review pass specifically so `app.ts`/`server.ts`
couldn't drift out of sync) — now a third call site of the same helper; (5) the harness's own
`FRESH_HOLD_RETRY_BUDGET_MS`/`HOLD_TTL_SECONDS` nesting requirement (finding 2 above) was asserted
only in comments/prose with nothing enforcing it — `runHoldExpiryPattern` now validates the
observed TTL against the retry budget before ever firing k6, turning that whole failure class into
a clear startup error instead of confusing evidence; (6)-(7) two stale doc comments (a "Four load
patterns" header left at four after this ticket added a fifth, and `Args.concurrency`'s per-pattern
doc comment missing a hold-expiry bullet) fixed, the latter also now noting hold-expiry's 10x
VU-per-seat multiplier (steeper than every other pattern's, previously undocumented); (8) a
`seeds` field written into every report but never read by `aggregate.ts`'s Exhibit F removed as
dead output; (9) CLAUDE.md declared issues #37/#41 complete while they were still open on
GitHub — closed to match. The measurement was re-run after all fixes landed; the exhibit's numbers
above are the post-fix run. Full test suite passes unmodified (150 tests) and `npm run typecheck`
is clean. Phase 5 (todo.md, issues #37-#41) is now complete.

Phase 6 (formal proof + chaos testing, umbrella #42) is complete except the optional C4. It was
scoped through a grilling session (glossary: Fault, Ambiguous outcome, Oracle, Correctness
violation, Robustness finding in CONTEXT.md) into two independent tracks, each built tracer-first,
every checker paired with a negative control shown to fail, and a measure-first policy on
unmodified production code — `src/` and `db/schema.sql` were not touched by any Phase 6 ticket.
**Formal track** (`formal/`, F1-F5 = #43, #45-#48): four small-scope TLA+ modules (3 requests, 3
seats, seat sets of 1-2) model-checked exhaustively by TLC in a pinned Docker image, no local Java
(`npm run formal:check` / `formal:check:negative`): `SeatBooking` (claim, multi-seat atomicity),
`DeadlockFreedom` (A/B: unsorted blocking acquisition deadlocks in 3 steps; sorted and NOWAIT
cannot), `SeatLifecycle` (hold/confirm/expire/reaper/cancel, reaper liveness under fairness), and
`CrashRecovery` (a crash at any step plus same-key retry, including commit-then-crash). 9 positive
checks hold and 44 negative controls/witnesses fail for their stated reasons. A hand-audited
spec-action to SQL mapping, pinned to a commit, is guarded by a database-free drift test
(`test/formalMapping.test.ts`). See [Exhibit G](docs/evidence/exhibit-g-phase6-formal.md) and
ADR-0021. **Chaos track** (`load-harness/chaos/`, `npm run chaos` / `chaos:holds`, C1-C5 = #44,
#49-#52): four Oracles read from stored DB state (never HTTP codes) judged 505 measured runs across
backend-kill, latency below/above the timeout, partition stall/reset, and app SIGKILL, on all six
mechanisms plus the pessimistic hold lifecycle: **zero Correctness violations**, 16 of 16
end-to-end negative controls flagged (including `naive` on a scratch DB without the `UNIQUE`
constraint, since ADR-0008 stopped it double-booking live). The unmodified app crashes on the first
torn connection, so unmodified runs judge little; the meaningful evidence is the separately
reported `--survive-uncaught` scaffolded runs (ADR-0022). See [Exhibit H](docs/evidence/exhibit-h-phase6-chaos.md),
`aggregate.ts --exhibit h`, ADR-0022/0023. **Not fixed, deliberately (measure first):** nine
Robustness findings are filed as fix tickets — R1 #53, R2 #54, R3 #55, R4 #56 (no timeouts: a
partition stalls requests and row locks for its whole duration), R7 #57 (a stalled reaper blocks
unrelated Holds/Confirms), R5 #58, R6 #59, and two found by model checking rather than any run,
RF1 #60 (an Idempotency Key lives only as long as its booking/hold row, so a retry after Cancel or
reap creates a second Booking) and RF2 #61 (a concurrent same-key retry can get a spurious 409);
note R1 needs a per-checkout `client.on("error")`, not only `pool.on("error")`. The F5 mapping
audit also noted, unticketed: O1 (a losing attempt briefly row-locks seats it won't get, so a
concurrent confirm can get a spurious 409), O2 (`unique_constraint`'s `ON CONFLICT` waits rather
than failing fast), O3 (replaying a Hold returns 201 even if it has since expired). **C4 (Postgres
restart under load, #51) was not run**, so "a returned COMMIT survives the database being killed"
is assumed by the formal model and tested by neither track. Full test suite passes (413 tests, 4
skipped that need a local Toxiproxy server) and `npm run typecheck` is clean. Phase 8's writeup
should cite both exhibits.

Issue #53 (finding R1, the first Phase 6 Robustness fix) is done: a torn checked-out
connection now fails only its own request instead of ending the process. `src/db/pool.ts`
registers `pool.on("connect", ...)` to attach a persistent `client.on("error")` to every
connection (pg-pool removes its own listener on checkout, so `pool.on("error")` alone can't
cover this) plus a no-op `pool.on("error")` for the idle path, which the fix could not meet its
acceptance without (ADR-0024; overlaps R2/#54 on purpose). Unmodified-app before/after reruns
(C1/C2/C3, no `--survive-uncaught`): the app exited in 0 of 67 after-runs (before: every run
under a connection-tearing Fault); all Oracles green; Exhibit H gained section E with the
numbers. The other eight Robustness findings (R2-R7, RF1, RF2) remain unfixed.

Issue #55 (finding R3) is done: a dead connection no longer masks the real error, and an
infrastructure failure is a designed outcome instead of a bare 500. `src/db/pool.ts`'s three
transaction helpers roll back through a best-effort helper (a failing `ROLLBACK` is logged as
secondary, the original error object is rethrown untouched, and a designed no-commit result such
as a `409`/`404` survives a failing closing `ROLLBACK`; a failing `COMMIT` is still thrown, its
outcome being unknown); the global error handler answers a connection-level failure (classified
by `isInfrastructureFailure` in `src/db/pgErrors.ts`) with HTTP **502**, `Retry-After: 1`, body
`outcome: "infrastructure_failure"`, deliberately not `503` (ADR-0012/0015: that stays
`retry_exhausted`'s) — ADR-0025 records why and the client retry contract. Scaffolded
(`--survive-uncaught`, run before R1 landed) before/after reruns: client-visible unclassified
500s went to 0 in every measured cell (C1 53 to 0, C2 `partition-reset` 894 to 0, C3 258 to 0),
the catch-block `ROLLBACK`/`BEGIN` as top logged frame went from 66 of 67 to 0 of 84, and every
retried Confirm still completed exactly once; all Oracles green, negative controls still red.
Exhibit H gained section F. The other seven Robustness findings stay unfixed (R4-R7, RF1, RF2;
R2 is its own PR).

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
