// The backend-kill Fault's application_name allow-list (issue #50): when the
// harness names the application it may kill, no other connection in the same
// database is eligible — the guard that keeps a run on a shared Postgres from
// ever terminating another session's backends. Lives apart from
// faults.test.ts (C1's contract) so the two tickets' tests don't collide.
import "dotenv/config";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { killBackendsOnce } from "../../load-harness/chaos/faults.js";
import { createScratchDb, type ScratchDb } from "../../load-harness/chaos/scratchDb.js";

let scratch: ScratchDb;
const open: Client[] = [];

beforeAll(async () => {
  scratch = await createScratchDb(process.env.DATABASE_URL!, []);
});

afterAll(async () => {
  for (const client of open) await client.end().catch(() => undefined);
  await scratch?.drop();
});

async function victim(applicationName: string): Promise<number> {
  const client = new Client({ connectionString: scratch.connectionString, application_name: applicationName });
  client.on("error", () => undefined);
  await client.connect();
  open.push(client);
  await client.query("BEGIN");
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
}

async function alive(pid: number): Promise<boolean> {
  return (await scratch.pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rowCount === 1;
}

describe("backend-kill Fault: onlyApplicationName", () => {
  it("kills the named application's backends and spares every other application's (clean twin: unset kills both)", async () => {
    const mine = await victim("racetoseat-c3-app");
    const neighbour = await victim("someone-elses-app");
    await killBackendsOnce(scratch.pool, { fraction: 1, scope: "in-transaction", onlyApplicationName: "racetoseat-c3-app" });
    await new Promise((r) => setTimeout(r, 200));
    expect(await alive(mine)).toBe(false);
    expect(await alive(neighbour)).toBe(true);

    const another = await victim("racetoseat-c3-app");
    await killBackendsOnce(scratch.pool, { fraction: 1, scope: "in-transaction" });
    await new Promise((r) => setTimeout(r, 200));
    expect(await alive(another)).toBe(false);
    expect(await alive(neighbour)).toBe(false);
  });
});
