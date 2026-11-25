// Network Faults for the chaos harness (issue #49, C2), injected with
// Toxiproxy between the app-under-test and Postgres: latency below/above the
// client's request timeout, and a partition that is later healed.
//
// Toxiproxy semantics these drivers were built on (probed against 2.12.0, not
// assumed — see docs/evidence/chaos-c2-fault-matrix.md):
//   - `latency` toxic: delays every chunk; REMOVING it flushes what was
//     buffered, so an in-flight query completes the moment the toxic goes.
//     That makes it a lossless "slow link" — clients see a late answer.
//   - `timeout` toxic (timeout=0): swallows traffic and holds the connection
//     open — a silent partition. REMOVING it does not resume the session: the
//     swallowed bytes are gone, so the proxy tears the connection down and
//     both ends see it close. "Heal" therefore means "new connections work
//     again"; connections that were stalled during the partition die at heal.
//   - `reset_peer` toxic: every connection is RST'd — a loud partition.
// All of this is the Fault's own behavior and is recorded as found.
//
// Every proxy this module creates is named `c2-...` and only ever deletes the
// proxy it created: the Toxiproxy server may be shared with other sessions.

export class ToxiproxyClient {
  constructor(private readonly apiUrl: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Toxiproxy ${method} ${path} -> ${res.status}: ${text}`);
    return text === "" ? undefined : JSON.parse(text);
  }

  async createProxy(name: string, listen: string, upstream: string): Promise<void> {
    await this.call("POST", "/proxies", { name, listen, upstream, enabled: true });
  }

  async deleteProxy(name: string): Promise<void> {
    await this.call("DELETE", `/proxies/${encodeURIComponent(name)}`);
  }

  async addToxic(
    proxy: string,
    toxic: { name: string; type: string; stream: "upstream" | "downstream"; attributes: Record<string, number> },
  ): Promise<void> {
    await this.call("POST", `/proxies/${encodeURIComponent(proxy)}/toxics`, { ...toxic, toxicity: 1 });
  }

  async removeToxic(proxy: string, name: string): Promise<void> {
    await this.call("DELETE", `/proxies/${encodeURIComponent(proxy)}/toxics/${encodeURIComponent(name)}`);
  }

  async isUp(): Promise<boolean> {
    try {
      await this.call("GET", "/version");
      return true;
    } catch {
      return false;
    }
  }
}

export type NetworkFaultKind = "latency-below" | "latency-above" | "partition-stall" | "partition-reset";

export const NETWORK_FAULT_KINDS: readonly NetworkFaultKind[] = [
  "latency-below",
  "latency-above",
  "partition-stall",
  "partition-reset",
];

export interface NetworkFaultOptions {
  // Per-chunk latency on the Postgres -> app direction (so each protocol
  // round trip costs about this much extra).
  latencyBelowMs: number;
  latencyAboveMs: number;
  // Partition: starts `partitionStartMs` (+ a random 0..partitionJitterMs) after
  // the load is first seen hitting the database (`waitForLoad`), lasts
  // `partitionDurationMs`, then heals. The jitter varies where in a
  // transaction's life the cut lands from one repeated run to the next.
  partitionStartMs: number;
  partitionJitterMs: number;
  partitionDurationMs: number;
  // Resolves when the load has started; absent = start counting immediately.
  waitForLoad?: () => Promise<unknown>;
  // How many app transactions are open right now (read at the instant the
  // Fault lands, to show it caught work mid-flight rather than an idle app).
  probeOpenTx?: () => Promise<number>;
  // Constant extra latency (ms per chunk) applied for the whole run, for Faults
  // whose cut points would otherwise all land after a fast load is already
  // over. 0 = none. Never applied to the latency-* kinds (they ARE the latency).
  baseLatencyMs: number;
}

// A constant mild latency toxic on its own, for runs whose Fault is not a
// network one (app-sigkill) but still wants transactions long enough to be cut
// mid-flight.
export async function startBaseLatency(tox: ToxiproxyClient, proxy: string, latencyMs: number): Promise<{ stop(): Promise<void> }> {
  if (latencyMs <= 0) return { async stop() {} };
  await tox.addToxic(proxy, { name: "c2-base-latency", type: "latency", stream: "downstream", attributes: { latency: latencyMs, jitter: 0 } });
  return {
    async stop() {
      await tox.removeToxic(proxy, "c2-base-latency").catch(() => undefined);
    },
  };
}

export interface NetworkFaultTimeline {
  kind: NetworkFaultKind;
  // ms since the fault driver started (i.e. since the load was fired).
  appliedAtMs: number | null;
  healedAtMs: number | null;
  // What was applied, for the report.
  latencyMs?: number;
  partitionDurationMs?: number;
  baseLatencyMs?: number;
  openTxWhenApplied?: number;
}

export interface NetworkFault {
  // Waits for a scheduled heal if one is pending, makes sure no toxic is left
  // behind, and returns what happened and when.
  stop(): Promise<NetworkFaultTimeline>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startNetworkFault(
  tox: ToxiproxyClient,
  proxy: string,
  kind: NetworkFaultKind,
  options: NetworkFaultOptions,
): Promise<NetworkFault> {
  const t0 = Date.now();
  const timeline: NetworkFaultTimeline = { kind, appliedAtMs: null, healedAtMs: null };
  const applied: string[] = [];

  const apply = async (toxics: Parameters<ToxiproxyClient["addToxic"]>[1][]) => {
    for (const toxic of toxics) {
      await tox.addToxic(proxy, toxic);
      applied.push(toxic.name);
    }
    timeline.appliedAtMs = Date.now() - t0;
  };
  const heal = async () => {
    for (const name of applied.splice(0)) await tox.removeToxic(proxy, name).catch(() => undefined);
    timeline.healedAtMs = Date.now() - t0;
  };

  if (kind === "latency-below" || kind === "latency-above") {
    const latency = kind === "latency-below" ? options.latencyBelowMs : options.latencyAboveMs;
    timeline.latencyMs = latency;
    await apply([{ name: "c2-latency", type: "latency", stream: "downstream", attributes: { latency, jitter: 0 } }]);
    return {
      async stop() {
        await heal();
        return timeline;
      },
    };
  }

  const base = await startBaseLatency(tox, proxy, options.baseLatencyMs);
  // Partition kinds: applied after a delay, healed after the duration — on
  // their own clock, independent of whether the load has already finished.
  timeline.partitionDurationMs = options.partitionDurationMs;
  timeline.baseLatencyMs = options.baseLatencyMs;
  const toxics: Parameters<ToxiproxyClient["addToxic"]>[1][] =
    kind === "partition-stall"
      ? [
          { name: "c2-partition-down", type: "timeout", stream: "downstream", attributes: { timeout: 0 } },
          { name: "c2-partition-up", type: "timeout", stream: "upstream", attributes: { timeout: 0 } },
        ]
      : [
          { name: "c2-partition-down", type: "reset_peer", stream: "downstream", attributes: { timeout: 0 } },
          { name: "c2-partition-up", type: "reset_peer", stream: "upstream", attributes: { timeout: 0 } },
        ];
  const scheduled = (async () => {
    await options.waitForLoad?.();
    await sleep(options.partitionStartMs + Math.random() * options.partitionJitterMs);
    timeline.openTxWhenApplied = await options.probeOpenTx?.().catch(() => undefined);
    await apply(toxics);
    await sleep(options.partitionDurationMs);
    await heal();
  })();

  return {
    async stop() {
      // The partition has its own duration: wait for it to run its course
      // rather than cutting it short because the (timed-out) load finished.
      await scheduled;
      if (applied.length > 0) await heal();
      await base.stop();
      return timeline;
    },
  };
}
