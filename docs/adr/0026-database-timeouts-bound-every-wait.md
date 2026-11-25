---
status: accepted
---

# Every wait on the database is bounded, and a bound that fires is HTTP 504

Finding R4 (issue #56, Exhibit H): nothing in the stack gave up. `src/db/pool.ts` built `new Pool({ connectionString, max })` and the server's `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` and `idle_session_timeout` were all `0`, so during a partition every in-flight request, its transaction and its row locks stalled for the *whole* partition (longest app transaction 30.1 s under a 30 s partition, slowest request 30,261 ms on `pessimistic`, up to 60 sessions holding row locks at once, transactions outliving the client's 5 s timeout in 92 of 120 `partition-stall` runs). TCP keepalive cannot rescue it: a stalled path or a proxy still acknowledges the probes.

## Decision

Four bounds, none of them a hard-coded number (`src/config.ts`, all in milliseconds, all `{ min: 1 }` because pg and Postgres read `0` as "no timeout" and a zero override would silently switch the bound back off):

| bound | where it is enforced | env / default | what it ends |
|---|---|---|---|
| `statement_timeout` | Postgres, sent as a startup parameter on every connection | `DB_STATEMENT_TIMEOUT_MS` / 1500 | any one statement, **including a wait for a row lock** |
| `idle_in_transaction_session_timeout` | Postgres, startup parameter | `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` / 1500 | a session sitting in an open transaction with nothing running; this is what frees the row locks of a transaction whose client has stalled or vanished, *during* the partition |
| `query_timeout` | the app (pg client) | `DB_QUERY_TIMEOUT_MS` / 2000 | how long the app waits for any one statement's answer; the only bound that works when the network drops bytes silently, because no server-side error can then arrive |
| `connectionTimeoutMillis` | the app (pg-pool) | `DB_CONNECT_TIMEOUT_MS` / 2000 | opening a connection, or waiting for a free slot in a full pool |

`DB_QUERY_TIMEOUT_MS` must exceed `DB_STATEMENT_TIMEOUT_MS`; the process refuses to start otherwise. If the client gave up first, a slow-but-reachable server would be reported as unreachable and its connection destroyed, when the server was about to cancel the statement cleanly and keep the connection.

**Values.** The worst p99 measured anywhere under 1,000 concurrent requests is 258 ms (Exhibit C), so 1,500 ms is ~6x it: a bound that fires under ordinary contention would be a regression, and the no-Fault reruns in Exhibit H section G check that none does. The sum of the two server-side bounds, 3 s, is the longest a stalled transaction can stay open on the server (one statement cut off by `statement_timeout`, then the session ended by the idle bound); it stays under the 5 s client timeout the chaos harness uses (acceptance: no app transaction outlives it). Production deployments with a different client timeout tune the four env vars together; the constraint to keep is `statement + idle < the slowest client timeout you want transactions to respect`.

### `lock_timeout` is deliberately not set (the `55P03` collision)

`pessimistic`, `pessimisticHold` and `pessimisticConfirm` translate `55P03` (`lock_not_available`) from `FOR UPDATE NOWAIT` into `409`. A `lock_timeout` raises the same SQLSTATE, so setting one would risk a timeout being reported as "another request holds this seat". It is not needed: `statement_timeout` already bounds a lock wait (a blocked statement is still one statement), and it raises `57014`, a code nothing translates into a conflict. Two further guards, because an operator can set `lock_timeout` on a role or database behind the app's back:

- `NOWAIT` never waits, so `lock_timeout` can never fire *on the statement the strategies translate*; it could only fire on a later, non-`NOWAIT` statement of the same transaction, whose error is not inside the translating `catch`.
- `isLockNotAvailable` now excludes a `55P03` whose message says "lock timeout" (`isLockTimeout`), and `isTimeoutFailure` classifies it as a timeout. PostgreSQL's message text can be localised, so this is a backstop, not the mechanism; the mechanism is not setting the parameter.

Both halves are tested (`test/dbTimeouts.test.ts`: a lock wait cut off by `statement_timeout` is `57014` and not `55P03`; a real `lock_timeout` error is told apart from a real `NOWAIT` one; a `NOWAIT` conflict is still a `409`).

### A timeout must also take its connection down

pg's `query_timeout` rejects the query and **nothing else**. The connection is still waiting for the ReadyForQuery of the query it gave up on, so the catch block's `ROLLBACK` is not sent: it can only fail by timing out itself, a second full wait (4 s instead of 2 s, over the client's 5 s budget once a `BEGIN` is counted), and the poisoned client then goes back into the pool for the next request (`test/stalledConnection.test.ts`'s negative control shows both). `src/db/queryDeadline.ts` therefore destroys the connection's socket when a query times out, from `pool.on("connect")` like R1's hook (ADR-0024), so every checkout path and `pool.query` (the reaper) is covered. The queued `ROLLBACK` is then rejected at once, logged as secondary (ADR-0025, the timeout stays the error the caller sees), pg-pool discards the dead client on release, and the server idles the abandoned transaction out and releases its locks.

### The retry loops

The bounds are per statement and per idle gap, never per loop. Each `withSerializableTransaction` / `withDeadlockRetry` attempt, and each optimistic CAS attempt, restarts every clock; the jittered 1-5 ms backoff is far below the idle bound. A test runs three 600 ms statements inside one retry loop (1.8 s of statement time in total, over the 1.5 s bound) and the loop completes. A timeout is *not* retriable: it is neither `40001` nor `40P01`, so it ends the loop on the first attempt and reaches the caller as the timeout, never as `retry_exhausted` (503, ADR-0012/0015), which keeps meaning "the mechanism ran and spent its retry budget". This is a bound on waiting, not on how long a slow-but-alive database may take in total: a request that retries on every attempt can still run for several bounds' worth of time. That is R6 (#59), not fixed here.

### The outcome is `504`, not `502` and not `500`

ADR-0025 reserved 504 for this ticket ("`504` was rejected because it means a timeout, and the app has no timeouts yet"). A bound that fires answers **`504`** with `Retry-After: 1` and `outcome: "timeout"`, checked before the infrastructure class because pg words its own connect timeout "Connection terminated due to connection timeout". Classified by `isTimeoutFailure` (`src/db/pgErrors.ts`): SQLSTATE `57014`, `25P03`, `25P04`, a `55P03` lock timeout, and the messages `Query read timeout`, `timeout exceeded when trying to connect`, `Connection terminated due to connection timeout`.

Why a status of its own: the database may be perfectly reachable, it just did not answer in time (a lock wait, a stalled path), which is the one case where an operator should look at contention or the network rather than at a dead database (`502`); and it must never look like `409`, `503` or `500`. The client contract is ADR-0025's, unchanged: **the outcome is unknown; retry with the same idempotency key.** A `COMMIT` that timed out may have landed, which the key's replay resolves.

One path stays `502` and is worth knowing: when `idle_in_transaction_session_timeout` ends a session, Postgres closes the connection, and the app learns of it as a dead connection ("Connection terminated unexpectedly"), not as the `25P03` the server wrote (the FATAL arrives with no query waiting, so pg surfaces it as a client `'error'` event, not as a query result). Behind a stalling proxy that is the common case (the proxy forwards the server's close); on a true blackhole the app's own `query_timeout` fires first and the answer is `504`. Both are retriable with the same key, so the difference is diagnostic only.

## Not adopted

- **TCP keepalive on the app's sockets.** A stalled path or a proxy acknowledges the probes (the ticket says so), `query_timeout` already bounds every statement, and the first statement on a dead pooled connection times out in 2 s and discards it.
- **An application-level request deadline.** Every wait is now bounded, and a request is a short fixed sequence of statements, so a stall costs at most one `query_timeout`. A deadline across a whole request would also have to cut into the retry loops, which is R6's question.
- **`transaction_timeout`** (PostgreSQL 17+): unknown to older servers, which refuse a startup parameter they do not recognise; `statement_timeout` plus the idle bound already give the same ceiling (3 s) without making a version a hard requirement.
- **`idle_session_timeout`**: it ends sessions idle *outside* a transaction, including the pool's own idle connections, which pg-pool already recycles (`idleTimeoutMillis`); ending them from the server would only surface as extra torn-connection noise (R2).

## Consequences

- A partition now costs a request at most about one `query_timeout` (2 s) and a transaction at most about the 3 s server-side sum, instead of the length of the partition. Row locks are released during the partition, not at heal. Measured in Exhibit H section G.
- Every connection the app opens carries the two server-side settings, including the ones `load-harness/run.ts` imports for seeding and verification; a harness statement that ran past 1.5 s would now be cancelled.
- The test and dev Postgres containers need no change (the settings travel with the connection, nothing is configured on the server).
- Client-visible: a new status, `504`, that any 5xx-agnostic client already handles; the chaos harness and its Exhibit report it as a designed outcome, separate from unclassified 5xx.
- `src/db/pool.ts` keeps the pinned-line promise made for Exhibit G: the pool construction line count is unchanged (the options moved to `src/db/poolOptions.ts`), the two new imports shift the pinned lines by two, inside the drift test's tolerance, and the hook is appended at the end.
