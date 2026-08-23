import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: expected an integer, got "${raw}"`);
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
};
