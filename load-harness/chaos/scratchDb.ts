// Scratch databases for chaos negative controls (issue #44, ADR-0023).
//
// A checker that has never been seen to fail proves little, but the only way
// to make production code fail its own guarantee is to weaken it — and this
// project forbids a test-only toggle in production code. So the weakening
// happens in a *separate database*: the real db/schema.sql is applied to a
// freshly created scratch database, then named constraints are dropped from
// that copy. The production schema file, the application code, and the shared
// dev/test database are never touched. Deriving the scratch schema from
// schema.sql (rather than keeping a second hand-written copy) means it can't
// silently drift when the real schema changes — and dropping by constraint
// name fails loudly if a name changes, instead of quietly leaving the
// constraint in place and making a control pass vacuously.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export interface ConstraintToDrop {
  table: string;
  constraint: string;
}

// The UNIQUE(seat_id) backstops (ADR-0008) — what keeps `naive` from
// double-booking on the shared schema.
export const SEAT_UNIQUE_CONSTRAINTS: ConstraintToDrop[] = [
  { table: "booking_seats", constraint: "booking_seats_seat_id_key" },
  { table: "hold_seats", constraint: "hold_seats_seat_id_key" },
];

export const IDEMPOTENCY_UNIQUE_CONSTRAINTS: ConstraintToDrop[] = [
  { table: "bookings", constraint: "bookings_idempotency_key_key" },
  { table: "holds", constraint: "holds_idempotency_key_key" },
];

// Same application_name the chaos harness stamps on every connection it owns,
// so the backend-kill Fault can tell its own connections from the app's.
export const CHAOS_APPLICATION_NAME = "racetoseat-chaos";

export function chaosPool(connectionString: string, max = 5): Pool {
  return new Pool({ connectionString, max, application_name: CHAOS_APPLICATION_NAME });
}

export function withDatabaseName(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

export interface ScratchDb {
  name: string;
  connectionString: string;
  pool: Pool;
  drop(): Promise<void>;
}

export async function createScratchDb(
  baseConnectionString: string,
  dropConstraints: ConstraintToDrop[],
): Promise<ScratchDb> {
  const name = `racetoseat_chaos_${randomBytes(4).toString("hex")}`;
  const admin = chaosPool(withDatabaseName(baseConnectionString, "postgres"), 1);
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const connectionString = withDatabaseName(baseConnectionString, name);
  const pool = chaosPool(connectionString);
  try {
    await pool.query(readFileSync(fileURLToPath(new URL("../../db/schema.sql", import.meta.url)), "utf8"));
    for (const { table, constraint } of dropConstraints) {
      // No IF EXISTS: a renamed/removed constraint must fail this loudly.
      await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
    }
  } catch (err) {
    await pool.end();
    await dropDatabase(baseConnectionString, name);
    throw err;
  }

  return {
    name,
    connectionString,
    pool,
    async drop() {
      await pool.end();
      await dropDatabase(baseConnectionString, name);
    },
  };
}

async function dropDatabase(baseConnectionString: string, name: string): Promise<void> {
  const admin = chaosPool(withDatabaseName(baseConnectionString, "postgres"), 1);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
