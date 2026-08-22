import { Pool } from "pg";
import { config } from "../config.js";

// Default pg pool max (10) would serialize most of a 1,000-concurrent-request
// load test behind pool.connect() queuing rather than real DB concurrency —
// raised here so the Phase 0 harness exercises genuine concurrent access.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 50),
});
