import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intEnv(name: string, defaultValue: number, options: { min?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: expected an integer, got "${raw}"`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Invalid ${name}: expected an integer >= ${options.min}, got "${raw}"`);
  }
  return parsed;
}

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),
  port: Number(process.env.PORT ?? 3000),
  // Strategy is fixed per-process, not per-request (ADR-0002): a running
  // server instance always uses exactly one concurrency-control mechanism.
  bookingStrategy: process.env.BOOKING_STRATEGY ?? "naive",
  // Production default per ADR-0009; overridable per-call via the optimistic
  // strategy's own options param (tests force it to 0 to exercise
  // retry-exhaustion deterministically without a real cancellation race).
  optimisticMaxRetries: intEnv("OPTIMISTIC_MAX_RETRIES", 3),
  // Production default per ADR-0011 — more permissive than optimistic's,
  // since serialization failures are expected to scale with ordinary
  // concurrency rather than firing only on a rare race. Overridable per-call
  // for the same test-determinism reason as optimisticMaxRetries.
  serializableMaxRetries: intEnv("SERIALIZABLE_MAX_RETRIES", 5),
  // Total time budget for serializable's retry loop, alongside the count cap above (issue #59,
  // finding R6, ADR-0028): no further attempt starts once it is predicted to end past this. The
  // default is ADR-0026's server-side worst case for a stalled transaction (statement + idle
  // bound = 3 s), so the two time limits agree and the response stays under the 5 s client
  // timeout the chaos harness uses. { min: 1 } like the other time bounds: 0 would mean "refuse
  // every retry", not "no budget".
  retryBudgetMs: intEnv("RETRY_BUDGET_MS", 3000, { min: 1 }),
  // Governs withDeadlockRetry (ADR-0014). Same default and jittered-backoff
  // tuning rationale as serializableMaxRetries: a deadlock under adversarial
  // multi-seat load scales with concurrency, not a narrow rare race.
  deadlockMaxRetries: intEnv("DEADLOCK_MAX_RETRIES", 5),
  // A Hold's TTL is fixed and server-controlled, never a per-request client
  // field (ADR-0017/Phase 5 spec) — this is the only place it's configurable,
  // and only at deploy time. Default matches FR4's own example ("e.g. 5
  // minutes"); the load-test harness overrides it to a short value so
  // Phase 5's expiry evidence run doesn't need to wait out a real 5-minute
  // TTL. min: 1 rejects zero/negative overrides at startup — unlike the
  // retry-count configs above, 0 has no valid meaning here: a hold with a
  // non-positive TTL is expired before its own creation response is sent,
  // and (with no reaper yet, issue #40) the seat it claimed would be stuck
  // 'held' with no path back to 'available'.
  holdTtlSeconds: intEnv("HOLD_TTL_SECONDS", 300, { min: 1 }),
  // How often the reaper sweeps for expired holds. Env-overridable so the
  // load-test harness can use a short interval to keep its expiry-evidence
  // run fast, matching holdTtlSeconds' identical rationale. Only read by
  // server.ts's process-lifecycle wiring, not by the sweep function itself
  // (runReaperSweep takes its pool as a plain argument, no config coupling)
  // — so this has no effect on tests, which call the sweep directly rather
  // than waiting on the interval.
  reaperIntervalMs: intEnv("REAPER_INTERVAL_MS", 5000, { min: 1 }),
  // Database timeouts (issue #56, finding R4, ADR-0026). Before this nothing in
  // the stack gave up: a partition held every request, transaction and row lock
  // for its whole duration (a 30 s partition meant a 30 s stall). All four are
  // milliseconds and { min: 1 } like HOLD_TTL_SECONDS: pg and Postgres read 0 as
  // "no timeout", so a zero override would silently switch the bound back off.
  //
  // The defaults are ~6x the worst p99 measured at 1,000 concurrent requests
  // (Exhibit C: 258 ms), and a stalled transaction's worst case on the server
  // (one statement cut off by statement_timeout, then the session ended by the
  // idle-in-transaction timeout = 3 s) stays under the 5 s client timeout the
  // chaos harness uses.
  //
  // Server side, sent to Postgres as startup parameters on every connection.
  // The longest any one statement may run - this includes waiting for a row
  // lock, which is why there is deliberately no lock_timeout: it raises 55P03,
  // the code NOWAIT conflicts already use and the strategies translate to 409.
  dbStatementTimeoutMs: intEnv("DB_STATEMENT_TIMEOUT_MS", 1500, { min: 1 }),
  // The longest a session may sit inside an open transaction doing nothing.
  // This is what releases the row locks of a transaction whose client has
  // vanished or stalled (a partition), during the partition rather than at heal.
  dbIdleInTransactionTimeoutMs: intEnv("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", 1500, { min: 1 }),
  // Client side. How long the app waits for any one statement's answer before
  // giving up and destroying the connection - the only bound that works when the
  // network drops bytes silently, because then no server-side error can arrive.
  // Must exceed dbStatementTimeoutMs (checked below): a slow-but-reachable
  // server should answer with its own 57014, which keeps the connection usable.
  dbQueryTimeoutMs: intEnv("DB_QUERY_TIMEOUT_MS", 2000, { min: 1 }),
  // How long to wait for a connection (opening one, or a free slot in a full pool).
  dbConnectTimeoutMs: intEnv("DB_CONNECT_TIMEOUT_MS", 2000, { min: 1 }),
};

if (config.dbQueryTimeoutMs <= config.dbStatementTimeoutMs) {
  throw new Error(
    `Invalid DB_QUERY_TIMEOUT_MS: ${config.dbQueryTimeoutMs} must exceed DB_STATEMENT_TIMEOUT_MS (${config.dbStatementTimeoutMs}), ` +
      "otherwise the client gives up on, and destroys the connection of, statements the server was about to cancel cleanly",
  );
}

// Single source of truth for "does this process's configured mechanism
// support the hold flow" (ADR-0017/0019) — both app.ts (gating the hold
// routes) and server.ts (gating the reaper) call this rather than each
// independently comparing config.bookingStrategy to the literal string, so
// the two can't drift out of sync with each other (found duplicated in code
// review).
export function strategySupportsHolds(): boolean {
  return config.bookingStrategy === "pessimistic";
}
