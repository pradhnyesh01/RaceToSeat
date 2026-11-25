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
    await finishTransaction(client, shouldCommit(result) ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (err) {
    await rollbackAfterFailure(client, err);
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
      await finishTransaction(client, shouldCommit(result) ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (err) {
      await rollbackAfterFailure(client, err);
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
      await finishTransaction(client, shouldCommit(result) ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (err) {
      await rollbackAfterFailure(client, err);
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

// Ending a transaction without losing the outcome that ended it (issue #55,
// finding R3, ADR-0025). Appended here, below everything the formal mapping
// (Exhibit G) pins by line number, for the same reason the torn-connection
// hook is.
//
// Two situations, deliberately different:
//
//  - `finishTransaction("COMMIT")`: a failure here is NOT tolerated. If the
//    connection dies around COMMIT the client cannot know whether the write
//    landed, so the error must reach the caller (it becomes the infrastructure
//    outcome, whose contract is "retry with the same key").
//  - `finishTransaction("ROLLBACK")`: this is a *designed* outcome (a lost race,
//    an unknown id — `shouldCommit` was false) whose answer was already decided
//    by reads inside the transaction; nothing needed persisting. If the
//    ROLLBACK itself cannot be sent the connection is dead, and Postgres
//    releases a dead backend's locks and discards its open transaction on its
//    own. So the 409/404 stands; turning it into an infrastructure error would
//    tell the client a lie about a request whose answer is known.
async function finishTransaction(client: PoolClient, statement: "COMMIT" | "ROLLBACK"): Promise<void> {
  if (statement === "COMMIT") {
    await client.query("COMMIT");
    return;
  }
  await rollbackAfterFailure(client, undefined);
}

// Best-effort ROLLBACK from a catch block (or a designed no-commit): it must
// release locks when it can, and must never replace the error being handled.
// A ROLLBACK that throws means the connection is already dead (it was the
// cause of the original failure, or died since); that is logged next to the
// original's message — both appear in the operator's log, the statement that
// actually failed stays the one the caller sees — and then ignored. The
// caller always rethrows the original itself.
async function rollbackAfterFailure(client: PoolClient, original: unknown): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackErr) {
    const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
    const originalMessage =
      original === undefined ? "(no error; a designed no-commit result)" : original instanceof Error ? original.message : String(original);
    console.error(`ROLLBACK also failed (connection already dead): ${rollbackMessage}; the error it did not replace: ${originalMessage}`);
  }
}
