import { createApp } from "./app.js";
import { config, strategySupportsHolds } from "./config.js";
import { pool } from "./db/pool.js";
import { startReaper, type Reaper } from "./reaper.js";

const app = createApp();

let reaper: Reaper | undefined;

async function shutdown(): Promise<void> {
  reaper?.stop();
  try {
    await app.close();
  } finally {
    await pool.end();
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

app.listen({ port: config.port }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`RaceToSeat listening on :${config.port} (strategy: ${config.bookingStrategy})`);

  // Started only once the server has actually bound its port — starting it
  // eagerly, before knowing app.listen will succeed, would let a sweep fire
  // a real write against the database during the brief window before a
  // listen failure (e.g. the port already being in use) exits the process
  // anyway. Same gating as app.ts's hold routes (ADR-0019): the reaper only
  // exists where holds can exist. Started here, not inside createApp() —
  // createApp() is called repeatedly across the test suite, and a real
  // setInterval there would leak background timers across test files
  // instead of running once for the life of the actual server process.
  if (strategySupportsHolds()) {
    reaper = startReaper(pool, config.reaperIntervalMs);
  }
});
