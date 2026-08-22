import type { PoolClient } from "pg";
import { Pool } from "pg";
import { config } from "../config.js";

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
