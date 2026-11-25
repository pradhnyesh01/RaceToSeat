// Fault drivers (issue #44). A Fault is a deliberately injected failure of
// the connection/network/process between the app and its database
// (CONTEXT.md) — never an ordinary losing request.
//
// C1 ships one: the backend kill. It runs `pg_terminate_backend` against
// Postgres backends mid-transaction while a load pattern is in flight, the
// closest scripted stand-in for "a connection died between two statements of
// a booking" or "the commit was in flight when the link dropped". It is
// driven from a connection that goes straight to Postgres (not through the
// Toxiproxy path the app uses) so the Fault can never cut off the thing
// injecting it.
import type { Pool } from "pg";
import { CHAOS_APPLICATION_NAME } from "./scratchDb.js";

export interface BackendKillOptions {
  // Delay between kill sweeps.
  intervalMs: number;
  // Probability each eligible backend is terminated on a given sweep — below
  // 1 so a run keeps making forward progress (some requests still complete)
  // instead of every transaction dying and nothing being left to judge.
  fraction: number;
  // "in-transaction": only backends with an open transaction (xact_start set)
  // — i.e. active mid-statement, or idle-in-transaction between statements.
  // "idle": only idle pooled connections (not in a transaction) — isolates
  // how the app's pool reacts to a dead *idle* connection (hypothesis 1).
  // "any": every non-harness client backend.
  scope: "in-transaction" | "idle" | "any";
  // When set, ONLY backends whose application_name equals this are eligible
  // (issue #50): a positive allow-list on top of the database-name scope and
  // the harness-name exemption, so a run sharing a Postgres server with other
  // sessions can name exactly whose connections it may kill. The app under
  // test picks its name up from PGAPPNAME (no src/ change needed).
  onlyApplicationName?: string;
}

export interface BackendKillStats {
  sweeps: number;
  terminated: number;
  terminatedByState: Record<string, number>;
}

export interface BackendKiller {
  stop(): Promise<BackendKillStats>;
}

// Kills only the *application's* backends: the chaos harness stamps its own
// connections with CHAOS_APPLICATION_NAME (see scratchDb.chaosPool), and the
// current backend (the killer's own) is excluded. Restricted to the current
// database so it never touches another project's connections on a shared
// server.
export async function killBackendsOnce(
  db: Pool,
  options: Pick<BackendKillOptions, "fraction" | "scope" | "onlyApplicationName">,
): Promise<{ state: string; terminated: boolean }[]> {
  const transactionFilter =
    options.scope === "in-transaction" ? "AND xact_start IS NOT NULL" : options.scope === "idle" ? "AND state = 'idle'" : "";
  const res = await db.query<{ state: string; terminated: boolean }>(
    `SELECT state, pg_terminate_backend(pid) AS terminated
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND backend_type = 'client backend'
       AND pid <> pg_backend_pid()
       AND application_name <> $1
       AND ($3::text IS NULL OR application_name = $3)
       ${transactionFilter}
       AND random() < $2`,
    [CHAOS_APPLICATION_NAME, options.fraction, options.onlyApplicationName ?? null],
  );
  return res.rows;
}

function tally(stats: BackendKillStats, rows: { state: string; terminated: boolean }[]): void {
  stats.sweeps += 1;
  for (const row of rows) {
    if (row.terminated) {
      stats.terminated += 1;
      stats.terminatedByState[row.state] = (stats.terminatedByState[row.state] ?? 0) + 1;
    }
  }
}

// One sweep, with stats — the idle-pool-kill Fault's whole body.
export async function killBackendsOnceWithStats(
  db: Pool,
  options: Pick<BackendKillOptions, "fraction" | "scope" | "onlyApplicationName">,
): Promise<BackendKillStats> {
  const stats: BackendKillStats = { sweeps: 0, terminated: 0, terminatedByState: {} };
  tally(stats, await killBackendsOnce(db, options));
  return stats;
}

export function startBackendKiller(db: Pool, options: BackendKillOptions): BackendKiller {
  const stats: BackendKillStats = { sweeps: 0, terminated: 0, terminatedByState: {} };
  let stopped = false;

  const loop = (async () => {
    while (!stopped) {
      try {
        tally(stats, await killBackendsOnce(db, options));
      } catch (err) {
        // The killer's own query failing (e.g. its connection was lost) must
        // not abort the run silently — surface it, then keep sweeping.
        console.error("backend killer sweep failed:", err);
      }
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  })();

  return {
    async stop() {
      stopped = true;
      await loop;
      return stats;
    },
  };
}
