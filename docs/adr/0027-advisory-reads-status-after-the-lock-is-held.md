---
status: accepted
---

# `advisory` reads a seat's status only after it holds the lock, and does not lean on the UNIQUE backstop

Finding R5 (issue #58, Exhibit H): `advisory.ts` read availability and tried the lock in one statement, `SELECT id, status, pg_try_advisory_xact_lock(hashtext(id::text)) AS acquired FROM seats WHERE id = ANY($1)`. Under READ COMMITTED a statement's snapshot is taken when it *starts*, but the `pg_try_advisory_xact_lock` call in its select list is evaluated *later*, per row. A loser could therefore snapshot a seat as `available`, the winner could then commit and release its lock, and only then would the loser's lock call run — and succeed. The loser held a lock and a stale `status = 'available'`, wrote its `bookings` row, and was refused only by the `booking_seats.seat_id UNIQUE` constraint (ADR-0008) with `23505`. No double-booking (all four Oracles stayed green), but unlike `naive.ts` and `serializable.ts`, `advisory.ts` never translated that violation, so the route answered an unclassified HTTP 500 instead of 409. The window is microseconds wide in a real run (1 of 420 chaos-matrix runs, none in 20 dedicated no-Fault reruns), and `load-harness/chaos/repro-advisory-snapshot-race.ts` widens it with a `pg_sleep` to show it deterministically.

## Decision

Two statements, in this order, inside the transaction:

1. `SELECT id, pg_try_advisory_xact_lock(hashtext(id::text)) AS acquired FROM seats WHERE id = ANY($1)` — existence and lock acquisition. Unknown seats still yield `404` and any lock not acquired still yields `409` immediately, exactly as before (ADR-0006's non-blocking acquisition is untouched, and so is the sorted `seat_ids` order of issue #30).
2. `SELECT status FROM seats WHERE id = ANY($1)` — availability, read only once every lock is held.

Statement 2 starts after statement 1 returned, so its snapshot is taken after the lock was acquired. A winner releases its advisory lock only when it commits (`_xact_`, ADR-0006), and Postgres makes a commit visible to new snapshots before it releases the committing transaction's locks. So *if this request holds the lock, it sees everything any earlier holder of that lock committed*, and a seat that was booked in the meantime reads as `booked` and answers a clean `409`. This is the same "check under the lock" shape `pessimistic` has (the row lock and the status come from one `FOR UPDATE` read), with the lock and the read split because an advisory lock is not attached to a row read.

Existence is still judged from statement 1's snapshot, which can predate a concurrent commit; that is safe only because a `seats` row is never deleted. If a path ever deletes seats, existence needs the same treatment.

## What we chose not to do

**Translating `booking_seats_seat_id_key` `23505` to `conflict`** (what `naive` and `serializable` do) was the other candidate. It would make the symptom 409, but it would also make the mechanism's own check optional: the race would still happen, still write a `bookings` row, and be cleaned up only by the transaction rolling back. For `serializable` that is the honest description (ADR-0013: the constraint resolves most real contention, SSI is the broader guard). For `advisory` it would be wrong, because the lock *is* supposed to be the gate (ADR-0010: "the row's `status` check inside the lock is still the actual gate"). The constraint stays defense-in-depth, as ADR-0008 describes it, **and `advisory` does not rely on it**: with the fix, the `23505` is unreachable from the booking path on a single mechanism.

Adding the translation as well would be untestable dead code (no interleaving reaches it) and would hide a regression of this very bug as a 409. A reappearance of this race therefore still fails loudly as a 500, and `test/strategies/advisoryStaleSnapshot.test.ts` guards it.

## Consequences

- **One more round trip** per attempt that holds all its locks (the winner and any loser whose lock calls succeed); a request that loses at statement 1 (`409`/`404`) is unchanged at one statement. The measured cost is in Exhibit H, section H.
- A hash collision between two different seats (ADR-0010) still only costs an unnecessary `409` through statement 1's failed lock; it cannot produce a stale read, since the colliding holder's commit is visible once its lock is released.
- Both statements assume READ COMMITTED (the pool default, and what `runTransactionalBooking` uses). Under REPEATABLE READ or SERIALIZABLE the second statement would reuse the first's snapshot and the fix would silently not work; nothing in the project runs `advisory` that way.
