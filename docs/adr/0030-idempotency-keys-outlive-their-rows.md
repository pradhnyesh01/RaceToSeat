---
status: accepted
---

# An Idempotency Key outlives its Booking or Hold: tombstones for a retention window, and a `410 key_released` answer

Finding RF1 (issue #60, found by model checking, `formal/README.md` "Findings"): the only home of an Idempotency Key was the `idempotency_key … UNIQUE` column of the live `bookings` / `holds` row (Phase 0/1, issue #1), and ADR-0020 deletes that row on Cancel, Confirm and reap. So the key was forgotten with its row. **Book → cancel → retry with the same key created a second Booking; hold → expire → reap → retry with the same key created a second, fresh Hold.** That contradicted the project's own glossary (`CONTEXT.md`: the key "must never produce two Bookings or two Holds"), and the formal model's `BookingKeyCreatesAtMostOne` / `HoldKeyCreatesAtMostOne` were false for the real code. Chaos Oracle 3 ("no key has more than one Booking") was satisfied, because it reads stored state and after the Cancel there is only one row, which is why no chaos run could see it.

The ticket's brief was to resolve the contradiction one way or the other. This ADR picks the first: **keep the key, not the contract.**

## The question that decides it: what should a stale retry after Cancel do?

A retry of `POST /bookings` carrying an old key reaches the server in two ways. Either it is a client retrying an attempt whose ack it never saw (the Ambiguous outcome; the booking may or may not exist), or it is a stale duplicate: a request delayed by a queue, a service worker, a double-submit, a second tab, a replayed message. The server cannot tell them apart. The cases where it matters:

- The user booked seat 14B, then cancelled it. A stale duplicate arrives. Under "key = row lifetime" the server **books 14B again**, for a user who had just cancelled it. That is the worst outcome the system can produce short of double-booking: a seat the user does not want, held against their name, and nothing in the response says it is not the original.
- The same, for a Hold that expired: a stale `POST /holds` re-holds seats for 5 minutes that nobody is going to confirm, blocking everyone else's attempt at them for that long.

"Document the contract" (option (b) below) would leave exactly this behavior in place and tell clients not to depend on it. Clients cannot defend against a request they did not send twice on purpose, so the safer default belongs on the server.

## Decision

### 1. Retain the key as a tombstone for a retention window

New table `idempotency_tombstones (kind, idempotency_key, resource_id, reason, released_at, expires_at)`, `PRIMARY KEY (kind, idempotency_key)` (`db/schema.sql`). `kind` is `booking` or `hold`, the two keys' separate namespaces as the two `UNIQUE` columns always were.

- **Written by the statement that releases the row**, as the last step of the data-modifying CTE that already deletes it (`src/db/tombstones.ts`): `DELETE /bookings/:id` (reason `cancelled`), confirm's teardown (the hold's key, `confirmed`), the reaper's sweep (`expired`). One statement, no new round trip, no instant at which the row is gone and the key forgotten.
- **No cost on the happy path**: nothing is written when a Booking or Hold is created, only when it is released (the alternative that writes a key record per claim is below).
- **Retention** is `IDEMPOTENCY_RETENTION_SECONDS`, default **24 hours**, `{ min: 1 }`. Past it a tombstone is ignored by lookups and by the guard, and a pruner (`startTombstonePruner`, every `IDEMPOTENCY_PRUNE_INTERVAL_MS`, default 60 s, started by `server.ts` for every mechanism since Cancel exists under all six) deletes it. The pruner is housekeeping: skipping it changes table size, never behavior. A key reused after its retention elapsed is a brand-new attempt, and the next release refreshes the stale tombstone (`ON CONFLICT … DO UPDATE`).
- **The guarantee is therefore "never two within the retention window", not "never"**, and `CONTEXT.md` now says so. An unbounded table would be a retention policy of "forever" at one row per cancelled booking; a day is the usual idempotency horizon and covers anything that was merely delayed.

### 2. A retry in the window answers `410 Gone`, `outcome: "key_released"`

Not a replay: there is no Booking or Hold to hand back, and a `201` with an id that `DELETE` now 404s would be a lie the client may act on. Not a new attempt: that is the bug. `409` already means "a seat is taken". `410` is the existing code for "this existed and is gone" (confirm of an expired Hold). Body: `{ error, outcome: "key_released", reason: "cancelled" | "confirmed" | "expired", released_id }`; `released_id` is the id the key had created, so a client can correlate. Same for `POST /holds`. A client that does want the seat again mints a new key. No `Retry-After` (unlike 502/504, retrying the same request cannot succeed). The answer comes before any look at seats: a stale key for seat A1 sent with seat B1 is still `key_released`, because the key identifies the attempt, not the seats.

This is a deliberate contract change: **a client that cancels and then re-books with the same key now gets `410`.** Nothing in the repo does that (every load pattern builds its key from a per-run UUID; the harness's `--repeat` resets seats with `DELETE` and starts a new run id), but an outside client that did would break, and that is the cost of making a key mean one attempt.

### 3. A trigger closes the lookup-then-insert window

Looking the key up before inserting leaves a window: a same-key request passes the lookup, the original then books, commits and is cancelled, and only then does the retry reach its `INSERT`. A `BEFORE INSERT` trigger on `bookings` and `holds` (`reject_released_idempotency_key`) refuses an unexpired tombstoned key at the insert itself, raising `unique_violation` naming `idempotency_tombstones_pkey`. The strategies' existing "lost the key race" fallback (`resolveIdempotencyKeyRace`, `resolveHoldIdempotencyKeyRace`) already handles a unique violation by looking the key up again; it now accepts that constraint too and resolves to `key_released` (or to a replay if the winner is live). So **every one of the six mechanisms' inserts, and confirm's, is covered with no edit to any of them**, and the six strategies' lookup block changed from "find a live row" to "find a live row or a tombstone" (`findPriorBookingForKey` / `findPriorHoldForKey`, one round trip over both tables, not two).

Tested deterministically (`test/idempotencyKeyRetention.test.ts`): a tombstone committed between the retry's lookup and its insert is `410`, and with the trigger disabled the same test creates a second Booking. Modelled: `CrashNoInsertGuard` / `CrashNoInsertGuardHold` fail `BookingKeyCreatesAtMostOne` / `HoldKeyCreatesAtMostOne` (`GuardMode = "off"`), `CrashWitnessReleasedRace` shows the window state is reachable.

### 4. `hold-confirm:<id>` synthesized keys need nothing

Confirm's Booking is keyed `hold-confirm:<hold id>` (issue #39). That key is not a client key and needs no retirement: the hold id is a UUID that is never reissued, and a confirm retried after its Booking was cancelled finds no hold and answers `404`, the same as confirm of any already-resolved hold id (pinned in `test/idempotencyKeyRetention.test.ts`). Confirm does not consult tombstones. A cancelled confirmed Booking does get a tombstone like any other (the cancel route does not know whose key it is): one row per cancelled confirmed Booking, never read, pruned with the rest. The *hold's own* client key, on the other hand, gets a `confirmed` tombstone, so a stale `POST /holds` after a confirm is `410`, not a second hold on seats that are now booked.

## What was considered

**(b) Keep key = row lifetime and amend the contract.** Free, and honest: `CONTEXT.md` would say "dedupes while the Booking/Hold exists". Rejected because of the stale-duplicate case above: the glossary's sentence was the right contract, the implementation was short of it, and the failure is a seat the user did not ask for, not an inconvenience. It would also have left the model's strong invariants false forever.

**(a2) A dedicated key table written at creation (`idempotency_keys`, PK on the key, one row per Booking/Hold).** Structurally airtight without a trigger: a same-key insert conflicts on the primary key whatever the timing. Rejected for cost and blast radius: one extra `INSERT` inside every booking and hold transaction on all six mechanisms (more rows locked and more WAL on the hot path the whole project benchmarks, and under `serializable` more predicate reads to conflict on), plus an `UPDATE` at release, plus six strategies' insert sites changed. The tombstone approach pays only when a row is released, and the trigger buys back the structural guarantee for the cost of one index probe per insert.

**A tombstone without the trigger (lookup only).** What a first implementation would do, and what the model refutes: `CrashNoInsertGuard` is a three-request counterexample to `BookingKeyCreatesAtMostOne`. Rejected.

**A longer or unbounded retention.** Unbounded is a table that grows with every cancellation forever. Configurable per deployment and 24 h by default is the choice; nothing in the code assumes the value.

## Consequences and costs

- **Behavior change** (above): `POST /bookings` and `POST /holds` can answer `410 key_released`. `BookSeatResult` and `HoldSeatsResult` gain a `key_released` kind.
- **One statement-internal write per released row** (Cancel, confirm, a reaped hold): an `INSERT … ON CONFLICT` inside the same statement. **One trigger probe per `bookings` / `holds` insert**, and a `UNION ALL` lookup in place of a single-table one. **Measured**, server-side in isolation (`docs/evidence/chaos/rf1-cost-sql.txt`, 50,000 operations, 5 rounds, µs per operation, avg): insert 5.5 → 8.5 (+3.1 for the trigger), lookup miss 1.7 → 4.3 (+2.6), release 7.6 → 19.7 (+12.1). Those are 1–2% of a request's ~300 µs of total CPU, and nothing like the round trips a request already makes. **End to end** (`docs/evidence/chaos/rf1-nofault/`, no Fault, 100 concurrent, 5 repeats per report; before = parent commit on its own database, alternating with after on one machine that also runs k6 and the app): `hammer-seat` is unchanged (p99 `naive` 35.0 → 36.7 ms, `pessimistic` 36.0 → 35.3 ms; one winner, 99 `409`, zero double-booking). On the zero-contention `spread-seats` the median `pessimistic` p99 was 27.7 → 38.6 ms (first pass) and, in three further alternating rounds, 27.2/25.1/29.1 → 36.1/32.7/32.8 ms with throughput 3,239/3,494/2,973 → 2,506/2,778/2,752 rps, and `naive` 26.7 → 31.0 ms. **The direction is consistent (after slower) and larger than the microbenchmark predicts, but the before runs themselves swing 2,894–4,234 rps between repeats, so the end-to-end cost is real-looking and of the order of 10% on the zero-contention path, not separable from noise by this measurement.** The first repeat of every report is cold for both variants (≈900–1,200 rps).
- **Table growth**: one row per released key, bounded by retention × release rate (24 h of Cancels). Pruned every minute.
- **Schema change**: existing databases need `npm run db:migrate` (which drops and recreates; this project has no data to preserve) or the new `CREATE TABLE`/`FUNCTION`/`TRIGGER` statements applied by hand. `resetDb` in the tests and `migrate.ts`'s drop list include the new table.
- **The model's claim moves from "false, documented" to "holds, within the retention window"**. The retention horizon is not modeled (no clock for it), and Postgres durability of the tombstone is the same assumption as for any committed row (`CommittedPersists`, C4 not run).
- ADR-0020 stands (rows are still deleted, no `holds.status`, no lineage FK); the tombstone is keyed by idempotency key and records only what that key created, not an audit trail of Holds.
- RF2 (#61, a spurious `409` on a concurrent same-key retry) is **not** fixed by this and is untouched; it edits the same helpers (`resolveIdempotencyKeyRace`), whose only change here is the added constraint name and the lookup function.
