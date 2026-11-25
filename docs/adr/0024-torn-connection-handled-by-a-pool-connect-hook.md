---
status: accepted
---

# A torn connection is handled by one `pool.on("connect")` hook, not by a checkout seam

Finding R1 (issue #53): when a connection that a request had checked out was torn (`pg_terminate_backend`, a TCP reset, a proxy teardown), the whole app process exited. pg emits `'error'` on the `Client`; Node ends the process on an `'error'` event with no listener; and pg-pool installs its own listener only while a client sits *idle*, removing it on checkout (`pg-pool/index.js` `_acquireClient`) and restoring it on release (`_release`). So `pool.on("error")` — the obvious fix — could never have covered the request path, and Exhibit H measured the consequence: every unmodified run under a connection-tearing Fault ended with the process gone after the first torn connection, so most of them judged almost nothing.

**Decision.** `src/db/pool.ts` registers `pool.on("connect", client => client.on("error", log))`. `'connect'` fires once per physical connection, when the pool creates it, so the listener is permanent for that client's life and survives pg-pool adding and removing its own across checkouts. The listener only logs (once per torn connection, with pg's message); it never swallows the failure, because pg already does the right thing downstream: the in-flight query — and every later query on that client — rejects with the underlying error, the request fails through the existing error path (a 500), and pg-pool discards the dead client on release because it is no longer queryable. A torn connection therefore cannot let a request report success.

The same file also registers `pool.on("error", () => {})` for the idle path (finding R2, #54). It does nothing on purpose: the per-client listener has already logged, and pg-pool has already removed the dead client. It is part of this change, not a scope creep, because R1's acceptance ("the process never exits under backend-kill") cannot be met without it: a kill sweep aimed at in-transaction backends sometimes lands on a client the request has *just released*, which then dies idle. The first C1 rerun carrying only the per-client listener crashed once in three runs through exactly that route (`Emitted 'error' event on BoundPool`). #54 keeps its own before/after criteria (idle-pool-kill rerun, partition-stall heal-only cases, its own regression test).

**Rejected: a single `acquireClient()` seam replacing the nine `pool.connect()` call sites.** It would work for today's call sites, but each of them would have to be edited, a tenth call site added later would silently reintroduce the crash (the failure is a whole-process exit that only shows up under a fault), and it would not cover `pool.query()` at all — which is how the reaper sweep checks a client out (pg-pool's `query` attaches only a `once('error')` for its own duration). A hook on the pool covers every present and future way of getting a client from it in one place, with no change to the strategies.

**Rejected: `client.once("error")`.** It would leave the client unprotected after its first error event; the persistent `on` costs nothing.

**What this does not do.** It does not classify the failure: the cut request still gets an unclassified 500, and the masking `ROLLBACK` on a dead client (R3, #55) is untouched. It does not bound how long a stalled connection hangs (R4, #56). It does not retry the cut request; idempotent recovery after a torn connection remains the client's job via the Idempotency Key, which is what Oracle 3 verifies.

**Placement.** The hook sits at the *end* of `pool.ts`: `docs/evidence/exhibit-g-phase6-formal.md` pins line numbers in that file and `test/formalMapping.test.ts` fails if they drift, so nothing was inserted above them.

**Evidence.** `test/db/tornConnection.test.ts` kills a booking's checked-out backend mid-transaction in a child process and asserts the process exits 0 and the pool keeps serving (it fails without the hook, with the exact `Unhandled 'error' event` crash). Exhibit H section E reruns the unmodified C1/C2/C3 Faults against the fixed code.
