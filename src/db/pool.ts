import type { PoolClient } from "pg";
import { Pool } from "pg";
import { config } from "../config.js";
import { isDeadlockDetected, isSerializationFailure } from "./pgErrors.js";

// Default pg pool max (10) would serialize most of a 1,000-concurrent-request
// load test behind pool.connect() queuing rather than real DB concurrency —
// raised here so the Phase 0 harness exercises genuine concurrent access.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 50),
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
// resolving (ADR-0011/ADR-0012). The DB layer doesn't know about
// BookSeatResult, so it signals exhaustion via this error rather than a
// result kind — callers map it to their own "exhausted" outcome.
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
      if (!isSerializationFailure(err)) {
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
