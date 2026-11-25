// The backend-kill Fault driver's own contract (issue #44): it must kill what
// it says it kills, and never the harness's own connections — if it killed
// the Oracles' or its own connection the run's verdict would be about the
// checker, not the system. Runs against a scratch database so it only ever
// sees the victim connections this file opens (the killer is scoped to the
// current database).
import "dotenv/config";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { killBackendsOnce, startBackendKiller } from "../../load-harness/chaos/faults.js";
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

async function victim(options: { inTransaction: boolean; applicationName?: string }): Promise<{ client: Client; pid: number }> {
  const client = new Client({
    connectionString: scratch.connectionString,
    application_name: options.applicationName ?? "app-under-test",
  });
  // A terminated connection emits 'error' — expected here, not a test failure.
  client.on("error", () => undefined);
  await client.connect();
  open.push(client);
  if (options.inTransaction) await client.query("BEGIN");
  await client.query("SELECT 1");
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  return { client, pid };
}

async function alive(pid: number): Promise<boolean> {
  const res = await scratch.pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
  return res.rowCount === 1;
}

describe("backend-kill Fault driver", () => {
  it("in-transaction scope kills a backend with an open transaction and spares an idle one", async () => {
    const inTx = await victim({ inTransaction: true });
    const idle = await victim({ inTransaction: false });
    const rows = await killBackendsOnce(scratch.pool, { fraction: 1, scope: "in-transaction" });
    expect(rows.filter((r) => r.terminated).length).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await alive(inTx.pid)).toBe(false);
    expect(await alive(idle.pid)).toBe(true);
  });

  it("idle scope kills an idle backend and spares one in a transaction", async () => {
    const inTx = await victim({ inTransaction: true });
    const idle = await victim({ inTransaction: false });
    await killBackendsOnce(scratch.pool, { fraction: 1, scope: "idle" });
    await new Promise((r) => setTimeout(r, 200));
    expect(await alive(idle.pid)).toBe(false);
    expect(await alive(inTx.pid)).toBe(true);
  });

  it("never kills a connection carrying the harness's own application_name, nor itself", async () => {
    const own = await victim({ inTransaction: true, applicationName: "racetoseat-chaos" });
    await killBackendsOnce(scratch.pool, { fraction: 1, scope: "any" });
    await new Promise((r) => setTimeout(r, 200));
    expect(await alive(own.pid)).toBe(true);
    // The killer's own pool still works.
    expect((await scratch.pool.query("SELECT 1 AS ok")).rows[0]!.ok).toBe(1);
  });

  it("fraction below 1 can spare a backend (it is a probability, not a flag)", async () => {
    const v = await victim({ inTransaction: true });
    for (let i = 0; i < 5; i += 1) await killBackendsOnce(scratch.pool, { fraction: 0.0000001, scope: "in-transaction" });
    expect(await alive(v.pid)).toBe(true);
  });

  it("the running killer reports what it terminated", async () => {
    const v = await victim({ inTransaction: true });
    const killer = startBackendKiller(scratch.pool, { intervalMs: 10, fraction: 1, scope: "in-transaction" });
    await new Promise((r) => setTimeout(r, 300));
    const stats = await killer.stop();
    expect(stats.sweeps).toBeGreaterThan(0);
    expect(stats.terminated).toBeGreaterThanOrEqual(1);
    expect(Object.keys(stats.terminatedByState).length).toBeGreaterThan(0);
    expect(await alive(v.pid)).toBe(false);
  });
});
