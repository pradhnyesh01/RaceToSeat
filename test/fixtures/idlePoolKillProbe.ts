// Child-process probe for test/idlePoolKill.test.ts (issue #54, finding R2).
// Fills the real app pool with idle connections, kills every one of their
// backends while nothing is in flight, then makes one more request. Run as a
// separate process because the failure being guarded against is the *process*
// exiting on an unhandled 'error' event, which an in-process test can't assert
// cleanly. Prints SURVIVED only if the process is alive after the kill and the
// next query succeeds on a fresh connection.
import "dotenv/config";
import { Client } from "pg";
import { pool } from "../../src/db/pool.js";

const appName = process.env.PGAPPNAME!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const held = await Promise.all(Array.from({ length: 5 }, () => pool.connect()));
held.forEach((c) => c.release());

const admin = new Client({ connectionString: process.env.DATABASE_URL, application_name: `${appName}-admin` });
await admin.connect();
const killed = await admin.query<{ terminated: boolean }>(
  "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
  [appName],
);
await admin.end();
console.log(`KILLED ${killed.rows.filter((r) => r.terminated).length}`);

// Give the torn sockets time to surface as 'error' events (the crash, if any).
await sleep(1000);

const res = await pool.query<{ ok: number }>("SELECT 1 AS ok");
console.log(res.rows[0]!.ok === 1 ? "SURVIVED" : "WRONG ANSWER");
await pool.end();
