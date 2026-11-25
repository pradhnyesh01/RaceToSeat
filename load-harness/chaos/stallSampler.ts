// Stall observer (issue #49): answers "did a transaction / lock stall, and for
// how long?" — the question C1 left open as Robustness finding R4 (no
// timeouts anywhere). Polls the app's own Postgres backends, found by their
// per-run application_name, from a connection that bypasses the Fault.
//
// Deliberately non-intrusive: it reads pg_stat_activity only. (A
// `FOR UPDATE SKIP LOCKED` probe, like Oracle 4's, would itself take row
// locks and could turn the app's NOWAIT acquisitions into spurious 409s
// while a run is in flight.) A backend whose transaction has been assigned an
// xid (`backend_xid`) is holding row locks, so "lock holders" counts those.
import type { Pool } from "pg";

export interface StallSample {
  tMs: number;
  openTx: number;
  idleInTx: number;
  lockHolders: number;
  oldestTxMs: number;
}

export interface StallSummary {
  samples: number;
  peakOpenTx: number;
  peakIdleInTx: number;
  peakLockHolders: number;
  // Age of the oldest transaction the app had open at any sample, i.e. the
  // longest a transaction (and the row locks it held) stayed open.
  maxOpenTxAgeMs: number;
  // Roughly one point per second: [tMs, openTx, lockHolders, oldestTxMs].
  timeline: [number, number, number, number][];
}

export interface StuckBackend {
  pid: number;
  state: string;
  txAgeMs: number;
  hasXid: boolean;
  query: string;
}

const COUNTS_SQL = `
  SELECT count(*) FILTER (WHERE xact_start IS NOT NULL)::int AS open_tx,
         count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_tx,
         count(*) FILTER (WHERE backend_xid IS NOT NULL)::int AS lock_holders,
         coalesce(max(extract(epoch FROM now() - xact_start)) * 1000, 0)::float8 AS oldest_tx_ms
  FROM pg_stat_activity
  WHERE datname = current_database() AND backend_type = 'client backend'
    AND application_name = $1 AND pid <> pg_backend_pid()`;

export async function sampleOnce(db: Pool, appName: string, tMs: number): Promise<StallSample> {
  const row = (await db.query(COUNTS_SQL, [appName])).rows[0]!;
  return {
    tMs,
    openTx: row.open_tx,
    idleInTx: row.idle_in_tx,
    lockHolders: row.lock_holders,
    oldestTxMs: Math.round(row.oldest_tx_ms),
  };
}

export interface StallSampler {
  stop(): Promise<StallSummary>;
}

export function startStallSampler(db: Pool, appName: string, intervalMs = 50): StallSampler {
  const t0 = Date.now();
  const samples: StallSample[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        samples.push(await sampleOnce(db, appName, Date.now() - t0));
      } catch {
        // A sampler hiccup must not abort the run; a missing sample is visible as a gap.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return summarize(samples);
    },
  };
}

export function summarize(samples: StallSample[]): StallSummary {
  let lastBucket = -1;
  const timeline: StallSummary["timeline"] = [];
  for (const s of samples) {
    const bucket = Math.floor(s.tMs / 1000);
    if (bucket !== lastBucket) {
      timeline.push([s.tMs, s.openTx, s.lockHolders, s.oldestTxMs]);
      lastBucket = bucket;
    }
  }
  return {
    samples: samples.length,
    peakOpenTx: Math.max(0, ...samples.map((s) => s.openTx)),
    peakIdleInTx: Math.max(0, ...samples.map((s) => s.idleInTx)),
    peakLockHolders: Math.max(0, ...samples.map((s) => s.lockHolders)),
    maxOpenTxAgeMs: Math.max(0, ...samples.map((s) => s.oldestTxMs)),
    timeline,
  };
}

// Resolves once the app has an open transaction in Postgres (the load has
// started hitting the database) — the anchor the timed Faults (partition,
// SIGKILL) hang their delay on, because a fixed delay from "k6 launched" can
// land after a fast load is already over. Gives up after `timeoutMs` and
// resolves anyway so a Fault never silently waits forever.
export async function waitForFirstTransaction(db: Pool, appName: string, timeoutMs = 8000, pollMs = 5): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await sampleOnce(db, appName, 0)).openTx > 0) return true;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

export interface DrainResult {
  // ms from the call (= the moment the Fault was cleared) until the app had no
  // open transaction left; null when the deadline passed first.
  drainedAfterMs: number | null;
  timedOut: boolean;
  // Backends still in a transaction when it gave up — the leaked transactions.
  stuck: StuckBackend[];
}

// After the Fault clears: how long until every transaction the app opened has
// ended? A transaction that never ends is a leaked lock (R4's worst case).
export async function waitForDrain(db: Pool, appName: string, timeoutMs: number, pollMs = 100): Promise<DrainResult> {
  const t0 = Date.now();
  for (;;) {
    const sample = await sampleOnce(db, appName, 0);
    if (sample.openTx === 0) return { drainedAfterMs: Date.now() - t0, timedOut: false, stuck: [] };
    if (Date.now() - t0 >= timeoutMs) {
      const res = await db.query(
        `SELECT pid, state, extract(epoch FROM now() - xact_start) * 1000 AS tx_age_ms,
                backend_xid IS NOT NULL AS has_xid, left(query, 120) AS query
         FROM pg_stat_activity
         WHERE datname = current_database() AND backend_type = 'client backend'
           AND application_name = $1 AND xact_start IS NOT NULL AND pid <> pg_backend_pid()`,
        [appName],
      );
      return {
        drainedAfterMs: null,
        timedOut: true,
        stuck: res.rows.map((r) => ({
          pid: r.pid,
          state: r.state,
          txAgeMs: Math.round(Number(r.tx_age_ms)),
          hasXid: r.has_xid,
          query: r.query,
        })),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
