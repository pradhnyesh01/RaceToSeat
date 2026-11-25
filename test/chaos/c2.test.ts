// Controls for the C2 Faults and the stall observer (issue #49, ADR-0023):
// each new Fault/checker has to be shown to do what the matrix claims it does,
// otherwise a clean matrix could mean "the Fault was never actually applied".
//   - stall sampler / drain wait: a transaction held open is seen, counted as a
//     lock holder, reported as stuck when it outlives the drain deadline, and
//     the wait returns once it ends (and ignores other applications' backends);
//   - app-kill driver: kills exactly maxKills times, waits for the load anchor,
//     and records what was in flight at each kill;
//   - network Faults (need a Toxiproxy server; skipped when none is reachable):
//     latency really delays, a stall partition really silences and its heal
//     really tears the stalled connection down, a reset partition really
//     resets, and the proxy is left clean.
import "dotenv/config";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAppKiller, type KillableApp } from "../../load-harness/chaos/appKillFault.js";
import { startNetworkFault, ToxiproxyClient } from "../../load-harness/chaos/networkFaults.js";
import { createScratchDb, type ScratchDb } from "../../load-harness/chaos/scratchDb.js";
import { sampleOnce, startStallSampler, waitForDrain } from "../../load-harness/chaos/stallSampler.js";

let scratch: ScratchDb;
const open: Client[] = [];

beforeAll(async () => {
  scratch = await createScratchDb(process.env.DATABASE_URL!, []);
});

afterAll(async () => {
  for (const client of open) await client.end().catch(() => undefined);
  await scratch?.drop();
});

async function appClient(applicationName: string, connectionString = scratch.connectionString): Promise<Client> {
  const client = new Client({ connectionString, application_name: applicationName });
  client.on("error", () => undefined);
  await client.connect();
  open.push(client);
  return client;
}

describe("stall sampler and drain wait", () => {
  it("counts an app transaction, its lock holding, and its age — and not another application's", async () => {
    const mine = await appClient("c2-test-sampler");
    const other = await appClient("c2-test-sampler-other");
    await mine.query("BEGIN");
    await mine.query("INSERT INTO events (name) VALUES ('sampler') "); // assigns an xid => holds locks
    await other.query("BEGIN");
    await other.query("SELECT 1");
    await new Promise((r) => setTimeout(r, 150));
    const sample = await sampleOnce(scratch.pool, "c2-test-sampler", 0);
    expect(sample.openTx).toBe(1);
    expect(sample.lockHolders).toBe(1);
    expect(sample.oldestTxMs).toBeGreaterThanOrEqual(100);
    await mine.query("ROLLBACK");
    await other.query("ROLLBACK");
    expect((await sampleOnce(scratch.pool, "c2-test-sampler", 0)).openTx).toBe(0);
  });

  it("drain wait reports a transaction that outlives the deadline as stuck, then drains once it ends", async () => {
    const leaked = await appClient("c2-test-drain");
    await leaked.query("BEGIN");
    await leaked.query("INSERT INTO events (name) VALUES ('drain')");
    const timedOut = await waitForDrain(scratch.pool, "c2-test-drain", 400, 50);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.drainedAfterMs).toBeNull();
    expect(timedOut.stuck).toHaveLength(1);
    expect(timedOut.stuck[0]!.hasXid).toBe(true);
    expect(timedOut.stuck[0]!.txAgeMs).toBeGreaterThanOrEqual(300);

    setTimeout(() => void leaked.query("COMMIT"), 200);
    const drained = await waitForDrain(scratch.pool, "c2-test-drain", 3000, 20);
    expect(drained.timedOut).toBe(false);
    expect(drained.drainedAfterMs).toBeGreaterThanOrEqual(100);
    expect(drained.stuck).toEqual([]);
  });

  it("the running sampler summarizes the peak it saw", async () => {
    const sampler = startStallSampler(scratch.pool, "c2-test-peak", 20);
    const c = await appClient("c2-test-peak");
    await c.query("BEGIN");
    await c.query("INSERT INTO events (name) VALUES ('peak')");
    await new Promise((r) => setTimeout(r, 250));
    await c.query("ROLLBACK");
    await new Promise((r) => setTimeout(r, 80));
    const summary = await sampler.stop();
    expect(summary.peakOpenTx).toBe(1);
    expect(summary.peakLockHolders).toBe(1);
    expect(summary.maxOpenTxAgeMs).toBeGreaterThanOrEqual(150);
  });
});

describe("app-kill driver", () => {
  function fakeApp(): KillableApp & { kills: number; ups: number } {
    return {
      kills: 0,
      ups: 0,
      async injectSigkill() {
        this.kills += 1;
        return true;
      },
      async ensureUp() {
        this.ups += 1;
      },
    };
  }

  it("kills exactly maxKills times, after the load anchor, and records in-flight work", async () => {
    const app = fakeApp();
    let anchorReleased = false;
    const killer = startAppKiller(app, {
      firstDelayMs: 20,
      intervalMs: 20,
      maxKills: 2,
      waitForLoad: async () => {
        await new Promise((r) => setTimeout(r, 150));
        anchorReleased = true;
      },
      probeOpenTx: async () => (anchorReleased ? 7 : -1),
    });
    await new Promise((r) => setTimeout(r, 1200));
    const stats = await killer.stop();
    expect(app.kills).toBe(2);
    expect(app.ups).toBe(2);
    expect(stats.kills).toBe(2);
    expect(stats.openTxAtKill).toEqual([7, 7]); // never fired before the anchor
    expect(stats.killedAtMs[0]!).toBeGreaterThanOrEqual(150);
  });

  it("stop() cancels a kill that has not fired yet", async () => {
    const app = fakeApp();
    const killer = startAppKiller(app, { firstDelayMs: 60_000, intervalMs: 1000, maxKills: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const stats = await killer.stop();
    expect(app.kills).toBe(0);
    expect(stats.kills).toBe(0);
  });
});

// --- network Faults, against a real Toxiproxy ----------------------------------

const toxApi = process.env.C2_TOXIPROXY_API ?? "http://localhost:8475";
const toxUpstream = process.env.C2_TOXIPROXY_UPSTREAM ?? "racetoseat-postgres:5432";
const toxPort = Number(process.env.C2_TEST_PROXY_PORT ?? 5449);
const tox = new ToxiproxyClient(toxApi);
const toxAvailable = await tox.isUp();

describe.skipIf(!toxAvailable)("network Faults (Toxiproxy)", () => {
  const proxy = `c2-test-${Math.random().toString(16).slice(2, 8)}`;
  const throughProxy = () => scratch.connectionString.replace(/:\d+\//, `:${toxPort}/`);

  const faultOptions = {
    latencyBelowMs: 50,
    latencyAboveMs: 300,
    partitionStartMs: 0,
    partitionJitterMs: 0,
    partitionDurationMs: 600,
    baseLatencyMs: 0,
  };

  beforeAll(async () => {
    await tox.createProxy(proxy, `0.0.0.0:${toxPort}`, toxUpstream);
  });
  afterAll(async () => {
    await tox.deleteProxy(proxy).catch(() => undefined);
  });

  async function rtt(client: Client): Promise<number> {
    const t = Date.now();
    await client.query("SELECT 1");
    return Date.now() - t;
  }

  it("latency adds roughly its value to every round trip, and removal restores normal speed", async () => {
    const c = await appClient("c2-test-net-latency", throughProxy());
    const baseline = await rtt(c);
    const fault = await startNetworkFault(tox, proxy, "latency-above", faultOptions);
    const slow = await rtt(c);
    const timeline = await fault.stop();
    const after = await rtt(c);
    expect(slow).toBeGreaterThanOrEqual(baseline + 250);
    expect(after).toBeLessThan(slow - 200);
    expect(timeline.latencyMs).toBe(300);
    expect(timeline.healedAtMs).not.toBeNull();
  });

  it("a stall partition silences a connection; its heal tears the stalled connection down, and new ones work", async () => {
    const c = await appClient("c2-test-net-stall", throughProxy());
    await c.query("SELECT 1");
    const fault = await startNetworkFault(tox, proxy, "partition-stall", faultOptions);
    await new Promise((r) => setTimeout(r, 100)); // partition applied
    const t = Date.now();
    const outcome = c.query("SELECT 2").then(
      () => ({ ok: true, ms: Date.now() - t }),
      (err: Error) => ({ ok: false, ms: Date.now() - t, message: err.message }),
    );
    const timeline = await fault.stop(); // waits out the partition, then heals
    const result = await outcome;
    expect(result.ok).toBe(false); // the stalled query never answered ...
    expect(result.ms).toBeGreaterThanOrEqual(400); // ... for (nearly) the whole partition
    expect(timeline.healedAtMs! - timeline.appliedAtMs!).toBeGreaterThanOrEqual(550);
    const fresh = await appClient("c2-test-net-stall-fresh", throughProxy());
    expect((await fresh.query("SELECT 3 AS n")).rows[0]!.n).toBe(3);
  });

  it("a reset partition resets connections at once, and new ones work after heal", async () => {
    const fault = await startNetworkFault(tox, proxy, "partition-reset", faultOptions);
    await new Promise((r) => setTimeout(r, 100));
    const t = Date.now();
    await expect(appClient("c2-test-net-reset", throughProxy())).rejects.toThrow();
    expect(Date.now() - t).toBeLessThan(400);
    await fault.stop();
    const fresh = await appClient("c2-test-net-reset-fresh", throughProxy());
    expect((await fresh.query("SELECT 4 AS n")).rows[0]!.n).toBe(4);
  });

  it("leaves no toxic behind on the proxy it used", async () => {
    const res = await fetch(`${toxApi}/proxies/${proxy}`);
    const body = (await res.json()) as { toxics: unknown[] };
    expect(body.toxics).toEqual([]);
  });
});
