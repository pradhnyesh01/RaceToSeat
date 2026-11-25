// R6 probe (issue #59, ADR-0027): per-request status, X-Booking-Retries header and duration for
// one mechanism under constant added latency, against a throwaway scratch database behind its
// own Toxiproxy proxy. Not a chaos run (no Oracles, no report): it exists to answer one
// question the chaos reports cannot, which is whether a request's retry loop actually ran. A
// chaos report only has HTTP statuses; this reads the X-Booking-Retries header (ADR-0012) too.
//
// Usage (DATABASE_URL = the Postgres to create the scratch database in, reachable directly):
//   DATABASE_URL=postgres://... npx tsx load-harness/chaos/probe-retry-latency.ts \
//     <strategy> <hammer-seat|deadlock-pairs> [latencyMs=100] [requests] \
//     [--toxiproxy-api http://localhost:8475] [--proxy-upstream racetoseat-postgres:5432] \
//     [--proxy-port 5491] [--app-port 3261] [--timeout-ms 5000]
// Prints one JSON line: wall time, the tally of `status/r<retries>` pairs (r-1 = no answer),
// and p50/p95/max request time. Env vars (e.g. RETRY_BUDGET_MS) pass through to the app.
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ToxiproxyClient } from "./networkFaults.js";
import { createScratchDb } from "./scratchDb.js";

const positional: string[] = [];
const opts = { api: "http://localhost:8475", upstream: "racetoseat-postgres:5432", proxyPort: 5491, appPort: 3261, timeoutMs: 5000 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]!;
  if (a === "--toxiproxy-api") opts.api = String(argv[++i]);
  else if (a === "--proxy-upstream") opts.upstream = String(argv[++i]);
  else if (a === "--proxy-port") opts.proxyPort = Number(argv[++i]);
  else if (a === "--app-port") opts.appPort = Number(argv[++i]);
  else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
  else positional.push(a);
}
const strategy = positional[0];
const load = positional[1];
if (!strategy || (load !== "hammer-seat" && load !== "deadlock-pairs")) {
  throw new Error("usage: probe-retry-latency.ts <strategy> <hammer-seat|deadlock-pairs> [latencyMs] [requests]");
}
const latency = Number(positional[2] ?? 100);
const n = Number(positional[3] ?? (load === "hammer-seat" ? 60 : 30));
const base = process.env.DATABASE_URL;
if (!base) throw new Error("DATABASE_URL is required");

const db = await createScratchDb(base, []);
const tox = new ToxiproxyClient(opts.api);
const proxyName = `probe-${randomUUID().slice(0, 6)}`;
await tox.createProxy(proxyName, `0.0.0.0:${opts.proxyPort}`, opts.upstream);
const appUrl = new URL(base);
appUrl.hostname = "localhost";
appUrl.port = String(opts.proxyPort);
appUrl.pathname = new URL(db.connectionString).pathname;

const eventId = (await db.pool.query<{ id: string }>("INSERT INTO events (name) VALUES ('R6 probe') RETURNING id")).rows[0]!.id;
const seatCount = load === "hammer-seat" ? 1 : n * 2;
const seats = (
  await db.pool.query<{ id: string }>("INSERT INTO seats (event_id, label) SELECT $1, 'A' || gs FROM generate_series(1, $2) gs RETURNING id", [eventId, seatCount])
).rows.map((r) => r.id);

const root = fileURLToPath(new URL("../../", import.meta.url));
const app = spawn(`${root}node_modules/.bin/tsx`, ["src/server.ts"], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: appUrl.toString(), BOOKING_STRATEGY: strategy, PORT: String(opts.appPort) },
  stdio: "ignore",
});
const url = `http://localhost:${opts.appPort}`;
for (let i = 0; i < 150; i += 1) {
  try {
    await (await fetch(`${url}/seats`)).arrayBuffer();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
await tox.addToxic(proxyName, { name: "latency", type: "latency", stream: "downstream", attributes: { latency, jitter: 0 } });

// deadlock-pairs: request 2p asks for [a, b], request 2p+1 for [b, a], so each pair races itself in opposite order.
const bodies = Array.from({ length: n }, (_, i) => {
  const pair = Math.floor(i / 2) * 2;
  const ids = load === "hammer-seat" ? [seats[0]!] : i % 2 === 0 ? [seats[pair]!, seats[pair + 1]!] : [seats[pair + 1]!, seats[pair]!];
  return { seat_ids: ids, user_id: `probe-${i}`, idempotency_key: `probe-${i}-${randomUUID()}` };
});
const started = Date.now();
const results = await Promise.all(
  bodies.map(async (body) => {
    const t = Date.now();
    try {
      const res = await fetch(`${url}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      await res.arrayBuffer();
      return { status: res.status, retries: Number(res.headers.get("x-booking-retries") ?? -1), ms: Date.now() - t };
    } catch {
      return { status: 0, retries: -1, ms: Date.now() - t };
    }
  }),
);
const tally: Record<string, number> = {};
for (const r of results) tally[`${r.status}/r${r.retries}`] = (tally[`${r.status}/r${r.retries}`] ?? 0) + 1;
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
console.log(JSON.stringify({ strategy, load, latency, requests: n, budgetMs: process.env.RETRY_BUDGET_MS ?? "default", wallMs: Date.now() - started, tally, p50: ms[Math.floor(n / 2)], p95: ms[Math.floor(n * 0.95)], max: ms[n - 1] }));

app.kill("SIGTERM");
await tox.deleteProxy(proxyName).catch(() => undefined);
await new Promise((r) => setTimeout(r, 500));
await db.pool.end().catch(() => undefined);
await db.drop().catch(() => undefined);
