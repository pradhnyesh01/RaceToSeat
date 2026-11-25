// App-process SIGKILL Fault (issue #49): kills the application server with
// SIGKILL while load is in flight, then lets the harness (standing in for a
// process supervisor) restart it. Unlike every other Fault this one never
// touches the database path: the connection dies because the *client* process
// vanished, so Postgres sees abrupt EOFs mid-transaction and must roll back
// on its own — no graceful shutdown handler, no pool.end(), no response sent.
//
// The kill is an injected Fault, not a Robustness finding: the harness counts
// it separately from genuine crashes (`app.exits`).

export interface KillableApp {
  // SIGKILLs the whole server process tree; false if there was nothing alive to kill.
  injectSigkill(): Promise<boolean>;
  // Resolves once the (restarted) server answers HTTP again.
  ensureUp(): Promise<void>;
}

export interface AppKillOptions {
  // First kill this long after the load starts, then every `intervalMs`
  // (measured from the previous restart completing), up to `maxKills`.
  firstDelayMs: number;
  intervalMs: number;
  maxKills: number;
  // Resolves when the load has started hitting the database; the first kill's
  // delay (+ jitter) counts from there. Absent = from the driver's start.
  waitForLoad?: () => Promise<unknown>;
  jitterMs?: number;
  // How many app transactions are open right now; read just before each kill.
  probeOpenTx?: () => Promise<number>;
}

export interface AppKillStats {
  kills: number;
  // ms since the driver started at which each kill landed.
  killedAtMs: number[];
  // ms each restart took to answer HTTP again.
  restartMs: number[];
  // App transactions open at the instant of each kill (work cut mid-flight).
  openTxAtKill: (number | undefined)[];
}

export interface AppKiller {
  stop(): Promise<AppKillStats>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function startAppKiller(app: KillableApp, options: AppKillOptions): AppKiller {
  const t0 = Date.now();
  const stats: AppKillStats = { kills: 0, killedAtMs: [], restartMs: [], openTxAtKill: [] };
  let stopped = false;
  const loop = (async () => {
    await options.waitForLoad?.();
    let delay = options.firstDelayMs + Math.random() * (options.jitterMs ?? 0);
    while (!stopped && stats.kills < options.maxKills) {
      // Sleep in small steps so stop() doesn't have to wait out a long delay.
      for (let waited = 0; waited < delay && !stopped; waited += 50) await sleep(50);
      if (stopped) break;
      const openTx = await options.probeOpenTx?.().catch(() => undefined);
      if (await app.injectSigkill()) {
        stats.openTxAtKill.push(openTx);
        stats.kills += 1;
        stats.killedAtMs.push(Date.now() - t0);
        const restartStart = Date.now();
        await sleep(500); // let the port actually free before probing readiness
        await app.ensureUp();
        stats.restartMs.push(Date.now() - restartStart);
      }
      delay = options.intervalMs;
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
