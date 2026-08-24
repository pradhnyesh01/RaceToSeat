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
};
