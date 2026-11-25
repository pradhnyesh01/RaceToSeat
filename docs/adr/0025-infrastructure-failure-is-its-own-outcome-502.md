---
status: accepted
---

# A dead database connection is its own outcome, HTTP 502, and never masks the error that caused it

Finding R3 (issue #55, Exhibit H): when a connection died mid-transaction, two things went wrong together. The catch block's `ROLLBACK` threw on the dead connection and **replaced** the error that had actually failed (the top frame of the logged error was the `ROLLBACK`/`BEGIN` in 66 of 67 requests in a like-for-like rerun of C1 on unmodified code), and the global error handler turned whatever came out into a bare `500 Internal server error`, which a client cannot tell apart from a bug in its own request.

## Decision

**1. A `ROLLBACK` never replaces the error it follows.** `withTransaction`, `withSerializableTransaction` and `withDeadlockRetry` roll back through one best-effort helper: if the `ROLLBACK` itself fails the connection is already dead (the server discards a dead backend's open transaction and releases its locks on its own), so the failure is logged next to the original's message and ignored, and the caller rethrows the *original* error object unchanged (callers match on its `code`, `constraint` and class). Attaching the original as a `cause` of a new error was rejected: every caller (`isUniqueViolation`, `isLockNotAvailable`, `instanceof SerializationRetriesExhaustedError`, ...) inspects the thrown value directly.

**2. A designed outcome survives a failing `ROLLBACK`.** A `409`/`404` result is decided by reads inside the transaction and carries nothing to persist, so the transaction's closing `ROLLBACK` (`shouldCommit` false) is best-effort too: the lost race is still a `409`, an unknown id still a `404`. A retry budget that is spent is still `503 retry_exhausted` (ADR-0012/0015), whether or not the `ROLLBACK` after the last failed attempt succeeded. A **`COMMIT`** that fails is *not* tolerated, because the client genuinely cannot know whether the write landed; it reaches the error handler.

**3. An infrastructure failure answers `502`, not `500` and not `503`.** The global error handler classifies an error as an infrastructure failure when it, or anything in its `cause` chain, is a connection-level failure (`isInfrastructureFailure`, `src/db/pgErrors.ts`: SQLSTATE class `08`, `57P01`-`57P03`, `53300`; Node socket errors such as `ECONNRESET`/`ECONNREFUSED`/`EPIPE`; pg's own "Connection terminated" / "not queryable" messages) and answers `502` with `Retry-After: 1` and a body carrying `outcome: "infrastructure_failure"`. Anything else stays `500`.

Why a new outcome rather than reusing `503`:
- `503 retry_exhausted` means *the mechanism ran, could not resolve contention within its budget, and never learned whether the seat was taken* (ADR-0012). An infrastructure failure means *the mechanism could not run*. A client or operator who reads one as the other will react wrongly (back off and wait for contention to clear vs. check the database).
- ADR-0012's whole point is that the benchmark's retry-exhaustion column must not be polluted by a different failure. The k6 patterns tally every `503` as retry exhaustion; folding infrastructure failures into `503` would inflate that metric under any fault run without anyone changing a line of reporting. A distinct status code keeps every existing tally honest for free (a `502` lands in "other" in those scripts), and the chaos reports count it on its own.
- `502` ("an upstream this server depends on gave no valid answer") is the standard status for exactly this; `504` was rejected because it means a timeout, and the app has no timeouts yet (R4, #56).

## The client contract

A `502` says: **the request's outcome is unknown; it is safe to retry.**
- `POST /bookings` and `POST /holds`: retry with the **same idempotency key**. If the first attempt committed, the retry returns the original `201`; if it did not, it books. (Caveat, not changed here: a key lives only as long as its booking/hold row, so a retry *after a cancel or a reap* can create a second one — RF1, #60.)
- `POST /holds/{id}/confirm`: retry as is; the synthesized `hold-confirm:<id>` key makes a repeat return the original booking, and a confirm that did not commit is simply attempted again. (A hold that expired in between is `410`.)
- `DELETE /bookings/{id}`: retry as is, but note this endpoint is deliberately not idempotent: if the first attempt had committed, the retry is `404`. Both mean the booking is gone.

`409`, `404`, `410` and `503` keep exactly the meanings they had. The chaos harness treats `502` as a designed outcome, reported separately from unclassified 5xx.

## Consequences

- Operator logs name the failing statement; a dead-connection `ROLLBACK` shows up once, as a secondary line.
- A client that previously saw `500` for a torn connection now sees `502`. Clients that treated every 5xx alike are unaffected; clients that distinguish them can now retry the right ones.
- This does not make a hung or partitioned connection fail faster (R4, #56) and does not stop the process dying on a torn connection (R1, #53, ADR-0024); it only makes the failure that does occur legible.
- Exhibit G pins `src/db/pool.ts` lines by anchor; the helper functions live at the end of the file for that reason.
