import type { PoolClient } from "pg";
import { Pool } from "pg";
import { config } from "../config.js";
import { isDeadlockDetected, isSerializationFailure } from "./pgErrors.js";

// Default pg pool max (10) would serialize most of a 1,000-concurrent-request
// load test behind pool.connect() queuing rather than real DB concurrency —
// raised here so the Phase 0 harness exercises genuine concurrent access.
// Raised again from 50 to 500 (issue #33) for the cross-seat-isolation
// pattern, which fires a 1,000-request hot-seat burst and a 1,000-seat
// background stream concurrently in one run: 50 would queue most of both
// streams behind pool.connect() before a single query runs, which would
// swamp the very degradation signal that pattern exists to measure. 500 (not
// the shared dev/test Postgres's max_connections=600 ceiling, see
// docker-compose.yml) leaves headroom for that container's own internal
// connections without paying the memory cost (~5-10MB per idle Postgres
// backend) of pushing all the way to it. Caveat: some residual pool-queuing
// effect may still remain at peak concurrency, since 500 pooled connections
// still isn't one-per-request at 1,000+ concurrent VUs — and this headroom
// figure is for one Pool instance; load-harness/run.ts's own process
// constructs a second, independent one from this same module for its
// seeding/verification queries, so real concurrent connections against the
// 600 ceiling can run higher than 500 alone would suggest.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 500),
});

// Shared BEGIN/COMMIT/ROLLBACK shape for every caller that needs a
// transaction on an already-checked-out client: every booking strategy and
// the cancellation route. `shouldCommit` lets a caller signal "nothing to
// persist" (e.g. a losing race, an unknown id) without treating that as an
// error — it still needs a ROLLBACK to release any locks taken along the
// way, just not the COMMIT that a real write gets. Defaults to always
// committing for callers with no such distinction.
export async function withTransaction<T>(
  client: PoolClient,
  fn: (client: PoolClient) => Promise<T>,
  shouldCommit: (result: T) => boolean = () => true,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn(client);
    await client.query(shouldCommit(result) ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export interface WithSerializableTransactionOptions {
  maxRetries?: number;
}

// Thrown when withSerializableTransaction exhausts its retry budget without
// resolving (ADR-0011/ADR-0012) — whether the retries were spent on genuine
// serialization failures (40001), deadlock aborts (40P01, issue #29's
// extension), or a mix of both; the loop shares one counter and cap across
// both causes, so there's no way to attribute exhaustion to just one. The DB
// layer doesn't know about BookSeatResult, so it signals exhaustion via this
// error rather than a result kind — callers map it to their own "exhausted"
// outcome.
export class SerializationRetriesExhaustedError extends Error {
  constructor(public readonly retries: number) {
    super(`Serializable transaction did not succeed after ${retries} ${retries === 1 ? "retry" : "retries"}`);
    this.name = "SerializationRetriesExhaustedError";
  }
}

function jitteredBackoffMs(): number {
  return 1 + Math.random() * 4;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SERIALIZABLE isolation, with its own retry loop rather than an isolation
// parameter on withTransaction (ADR-0011): a serialization failure (Postgres
// 40001) means the whole transaction must be replayed from BEGIN — re-reading
// fresh state, not just retried at its last statement — a shape none of the
// other mechanisms need. `fn` receives the current attempt number so a
// caller building its own result (e.g. `{ kind: "conflict", retries: attempt }`)
// can report how many retries it actually took, the same way optimistic's CAS
// loop does. The jittered 1-5ms backoff between attempts (vs optimistic's
// unjittered cap, ADR-0009) exists because serialization failures are
// expected to scale with ordinary concurrency rather than firing only on a
// rare race — a tight retry loop here would distort this project's own p99
// latency measurements.
//
// Also retries a deadlock abort (40P01, issue #29): serializable's multi-seat
// write is the same batched `INSERT INTO booking_seats ... SELECT
// unnest($ids)` shape naive's and unique_constraint's are (issues #26-#27),
// not optimistic's per-seat loop (#28) — so the deadlock risk here is
// specifically the ordered-array-order-preserving INSERT, same as ADR-0016's
// issue #26 correction found, not the later `UPDATE seats ... WHERE id =
// ANY($2)` (whose row-visitation order is plan-determined, not array-order-
// determined, so it can't deadlock regardless of ordering). Rather than
// nesting withDeadlockRetry (ADR-0014) as a second retry-from-BEGIN layer
// around a loop that already retries from BEGIN — which would issue two
// nested BEGINs on every retry — this loop's existing serialization-failure
// handling is extended to treat 40P01 the same way it treats 40001: same
// counter, same cap, same jittered backoff. Whichever error code triggered a
// given retry isn't tracked separately, matching ADR-0015's reasoning for
// reusing retry_exhausted rather than growing the result-kind vocabulary.
//
// Postgres fact worth knowing if you're staging a deterministic test against
// this function (see test/strategies/serializableRetryExhaustion.test.ts):
// a genuine 40001 requires BOTH sides of the conflict to be running under
// SERIALIZABLE. A transaction that merely reads here and then loses to a
// concurrent plain-BEGIN (READ COMMITTED) writer will not get a 40001 from
// that writer's commit — Postgres's SSI conflict detection only tracks
// read/write dependencies between transactions that are themselves
// SERIALIZABLE, so that race instead resolves via whatever other constraint
// exists (for this project, booking_seats' UNIQUE(seat_id), see ADR-0013),
// producing a plain 23505 instead. Confirmed by direct experimentation, not
// documented anywhere in Postgres's own error messages.
export async function withSerializableTransaction<T>(
  client: PoolClient,
  fn: (client: PoolClient, attempt: number) => Promise<T>,
  shouldCommit: (result: T) => boolean = () => true,
  options: WithSerializableTransactionOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? config.serializableMaxRetries;
  let attempt = 0;
  while (true) {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      const result = await fn(client, attempt);
      await client.query(shouldCommit(result) ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      if (!isSerializationFailure(err) && !isDeadlockDetected(err)) {
        throw err;
      }
      if (attempt >= maxRetries) {
        throw new SerializationRetriesExhaustedError(attempt);
      }
      attempt++;
      await sleep(jitteredBackoffMs());
    }
  }
}

export interface WithDeadlockRetryOptions {
  maxRetries?: number;
}

// Thrown when withDeadlockRetry exhausts its retry budget without resolving
// (ADR-0014/ADR-0015), mirroring SerializationRetriesExhaustedError's shape:
// the DB layer doesn't know about BookSeatResult, so it signals exhaustion
// via this error rather than a result kind — the calling strategy maps it to
// { kind: "retry_exhausted", retries }.
export class DeadlockRetriesExhaustedError extends Error {
  constructor(public readonly retries: number) {
    super(`Transaction did not succeed after ${retries} ${retries === 1 ? "retry" : "retries"} following a deadlock abort`);
    this.name = "DeadlockRetriesExhaustedError";
  }
}

// Plain BEGIN/COMMIT/ROLLBACK (not SERIALIZABLE) with the same retry/backoff/
// cap shape as withSerializableTransaction (ADR-0011), checking
// isDeadlockDetected (40P01) instead of isSerializationFailure (40001) —
// ADR-0014's dedicated helper for naive, unique_constraint, and optimistic's
// multi-seat deadlock-abort recovery. Not used by pessimistic or advisory
// (their NOWAIT/TRY acquisition can't enter a wait-for cycle, ADR-0006) or by
// serializable (its own withSerializableTransaction loop is extended to also
// treat 40P01 as retriable, rather than nesting a second retry-from-BEGIN
// layer around it).
export async function withDeadlockRetry<T>(
  client: PoolClient,
  fn: (client: PoolClient, attempt: number) => Promise<T>,
  shouldCommit: (result: T) => boolean = () => true,
  options: WithDeadlockRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? config.deadlockMaxRetries;
  let attempt = 0;
  while (true) {
    await client.query("BEGIN");
    try {
      const result = await fn(client, attempt);
      await client.query(shouldCommit(result) ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      if (!isDeadlockDetected(err)) {
        throw err;
      }
      if (attempt >= maxRetries) {
        throw new DeadlockRetriesExhaustedError(attempt);
      }
      attempt++;
      await sleep(jitteredBackoffMs());
    }
  }
}

// Torn-connection handling for every client this pool hands out. Kept at the
// end of the file on purpose: docs/evidence/exhibit-g-phase6-formal.md pins
// line numbers in this file (test/formalMapping.test.ts), so nothing may be
// inserted above them.
//
// A torn connection (pg_terminate_backend, TCP reset, proxy teardown) must
// fail only the request that owned it — never the process (issue #53, R1,
// ADR-0024). pg emits 'error' on a Client when its socket dies, and Node
// treats an 'error' event with no listener as an uncaught exception that ends
// the process. pg-pool installs its own listener only while a client sits idle
// in the pool and deliberately removes it while a request has the client
// checked out (pg-pool/index.js: `_acquireClient` removes it, `_release`
// restores it) — so `pool.on("error")` could never cover this path.
//
// The hook attaches one persistent listener per physical connection, at the
// moment the pool creates it, so every way of getting a client out of this
// pool is covered at once — `pool.connect()` in the six strategies,
// pessimisticHold/Confirm and the cancellation route, and `pool.query()`
// (the reaper sweep) — including call sites added later. The listener only
// logs; it must not swallow the failure: pg itself rejects the in-flight
// query (and every later query on that client) with the underlying error, so
// the owning request flows through the existing error path (a 500) and can
// never report success, and pg-pool discards the dead client on release
// because it is no longer queryable.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error(`Torn database connection (request in flight, if any, will fail): ${err.message}`);
  });
});

// The idle-client half of the same crash (finding R2, #54): a connection torn
// while it sits idle in the pool, or in the instant between a request
// releasing it and the tear landing — a chaos kill sweep aimed at in-flight
// transactions still hits this window, so R1's "the process never exits"
// cannot be met without it — makes pg-pool re-emit the client's error as a
// Pool 'error' event, which is just as fatal without a listener. pg-pool has
// already removed the dead client by then, and the per-client listener above
// has already logged it, so this listener deliberately does nothing more
// (logging here would double-report every idle tear).
pool.on("error", () => {});
