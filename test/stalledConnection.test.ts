// Issue #56 (finding R4, ADR-0026): the half of the fix a server-side setting cannot reach.
// During a network partition no byte arrives in either direction and nothing errors, so
// only the client can give up. pg's `query_timeout` rejects the *query* — but leaves the
// connection waiting for a ReadyForQuery that will never come, so the very next statement
// (the catch block's ROLLBACK) queues behind it forever and the request never answers. The
// guard under test destroys the connection when a query times out.
//
// A real Postgres sits behind a small TCP forwarder that can be told to swallow every byte,
// which is what Toxiproxy's `timeout` toxic does in the chaos harness (C2).
import { createServer, connect, type Server, type Socket } from "node:net";
import { describe, expect, it, afterEach } from "vitest";
import { Pool } from "pg";
import { destroyConnectionOnQueryTimeout } from "../src/db/queryDeadline.js";
import { isTimeoutFailure } from "../src/db/pgErrors.js";

const upstream = new URL(process.env.DATABASE_URL ?? "postgres://racetoseat:racetoseat@localhost:5433/racetoseat");

interface Forwarder {
  port: number;
  stall(): void;
  close(): Promise<void>;
}

async function startForwarder(): Promise<Forwarder> {
  let stalled = false;
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const toDb = connect({ host: upstream.hostname, port: Number(upstream.port || 5432) });
    sockets.add(client);
    sockets.add(toDb);
    client.on("data", (chunk) => { if (!stalled) toDb.write(chunk); });
    toDb.on("data", (chunk) => { if (!stalled) client.write(chunk); });
    client.on("error", () => toDb.destroy());
    toDb.on("error", () => client.destroy());
    client.on("close", () => toDb.destroy());
    toDb.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    stall: () => { stalled = true; },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const QUERY_TIMEOUT_MS = 300;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function stalledPool(guard: boolean) {
  const forwarder = await startForwarder();
  const pool = new Pool({
    host: "127.0.0.1",
    port: forwarder.port,
    user: decodeURIComponent(upstream.username),
    password: decodeURIComponent(upstream.password),
    database: upstream.pathname.slice(1),
    query_timeout: QUERY_TIMEOUT_MS,
    max: 2,
  });
  pool.on("error", () => {});
  pool.on("connect", (client) => {
    client.on("error", () => {});
    if (guard) destroyConnectionOnQueryTimeout(client);
  });
  cleanups.push(async () => {
    await pool.end().catch(() => {});
    await forwarder.close();
  });
  return { pool, forwarder };
}

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean; error?: unknown }> {
  const timer = new Promise<{ settled: boolean }>((resolve) => setTimeout(() => resolve({ settled: false }), ms));
  const outcome = promise.then(
    () => ({ settled: true }),
    (error: unknown) => ({ settled: true, error }),
  );
  return Promise.race([outcome, timer]);
}

describe("a query on a connection that has stopped answering (a partition)", () => {
  it("times out with a classified error, and the follow-up ROLLBACK fails fast instead of hanging", async () => {
    const { pool, forwarder } = await stalledPool(true);
    const client = await pool.connect();
    await client.query("BEGIN");
    forwarder.stall();

    const started = Date.now();
    const first = await settleWithin(client.query("SELECT 1"), 3000);
    expect(first.settled).toBe(true);
    expect(isTimeoutFailure(first.error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(QUERY_TIMEOUT_MS + 500);

    // The shape of withTransaction's catch block: ROLLBACK on the same client.
    const rollback = await settleWithin(client.query("ROLLBACK"), 1000);
    expect(rollback.settled).toBe(true);
    expect(rollback.error).toBeInstanceOf(Error);

    client.release();
    // The dead client was discarded, not returned to the pool.
    expect(pool.totalCount).toBe(0);
  });

  it("works for the callback form pool.query uses too, and frees the pool slot", async () => {
    const { pool, forwarder } = await stalledPool(true);
    await pool.query("SELECT 1");
    forwarder.stall();

    const result = await settleWithin(pool.query("SELECT 1"), 3000);

    expect(result.settled).toBe(true);
    expect(isTimeoutFailure(result.error)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pool.totalCount).toBe(0);
  });

  it("negative control — without the guard the dead query keeps blocking the connection: ROLLBACK waits out its own timeout, and the poisoned client goes back into the pool", async () => {
    const { pool, forwarder } = await stalledPool(false);
    const client = await pool.connect();
    await client.query("BEGIN");
    forwarder.stall();

    const first = await settleWithin(client.query("SELECT 1"), 3000);
    expect(isTimeoutFailure(first.error)).toBe(true); // pg's own query_timeout does fire...

    // ...but the connection is still waiting for the answer to the query it gave up on, so
    // the ROLLBACK is not sent: it can only fail by timing out itself, a second full wait.
    const started = Date.now();
    const rollback = await settleWithin(client.query("ROLLBACK"), 3000);
    expect(isTimeoutFailure(rollback.error)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(QUERY_TIMEOUT_MS * 0.8);

    client.release();
    expect(pool.totalCount).toBe(1); // a connection that can never answer is handed to the next request
  });
});
