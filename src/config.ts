import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),
  port: Number(process.env.PORT ?? 3000),
  // Strategy is fixed per-process, not per-request (ADR-0002): a running
  // server instance always uses exactly one concurrency-control mechanism.
  bookingStrategy: process.env.BOOKING_STRATEGY ?? "naive",
};
