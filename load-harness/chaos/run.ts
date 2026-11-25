// Chaos harness orchestrator (issue #44, ADR-0022/0023): runs an existing k6
// load pattern against a real app process while a Fault is injected, lets the
// Fault clear, replays every Idempotency Key, then judges the run with the
// four Oracles — read from database state, never from HTTP responses.
//
// What one run does:
//   1. Seeds seats directly (shared dev DB, or a throwaway scratch DB).
//   2. Starts the app (`src/server.ts`, UNMODIFIED) as a child process, its
//      DATABASE_URL pointed at the Toxiproxy listener so it exercises the same
//      connection path the network Faults (C2+) will; the harness's own
//      driver/oracle connections go straight to Postgres.
//   3. Fires the load pattern's k6 script while the Fault driver runs.
//   4. Clears the Fault; if the app process crashed it is restarted (a stand-in
//      for a process supervisor — the crash itself is recorded as a Robustness
//      finding, not hidden by the restart).
//   5. Snapshots Bookings per key, replays every key (the Ambiguous-outcome
//      recovery path), then runs Oracles 1-4.
//
// Exit status: nonzero iff an Oracle was violated (a Correctness violation —
// the only outcome that fails Phase 6, CONTEXT.md). Robustness findings are
// reported but don't affect it. `--expect-violations` inverts that for the
// negative controls (ADR-0023): there the run FAILS if the Oracles did NOT
// flag anything.
//
// Usage: tsx load-harness/chaos/run.ts [--strategy pessimistic]
//   [--load deadlock-pairs|hammer-seat|spread-seats] [--concurrency 150]
//   [--fault backend-kill|idle-pool-kill|none] [--kill-scope in-transaction|idle|any] [--survive-uncaught]
//   [--kill-interval-ms 40] [--kill-fraction 0.5]
//   [--db shared|scratch-no-unique] [--expect-violations] [--label name]
//   [--app-port 3100] [--proxy-port 5434]
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import "dotenv/config";
import { killBackendsOnceWithStats, startBackendKiller, type BackendKillStats } from "./faults.js";
import {
  runOracles,
  snapshotBookingsByKey,
  type BookingIntent,
  type OracleResult,
} from "./oracles.js";
import {
  chaosPool,
  createScratchDb,
  SEAT_UNIQUE_CONSTRAINTS,
  type ScratchDb,
} from "./scratchDb.js";

type LoadPattern = "deadlock-pairs" | "hammer-seat" | "spread-seats";

interface Args {
  strategy: string;
  load: LoadPattern;
  concurrency: number;
  fault: "backend-kill" | "idle-pool-kill" | "none";
  killScope: "in-transaction" | "idle" | "any";
  surviveUncaught: boolean;
  killIntervalMs: number;
  killFraction: number;
  db: "shared" | "scratch-no-unique";
  expectViolations: boolean;
  label: string;
  appPort: number;
  proxyPort: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    strategy: "pessimistic",
    load: "deadlock-pairs",
    // 60 (= 120 concurrent requests for deadlock-pairs): macOS's default
    // kern.ipc.somaxconn of 128 makes k6 -> app connections reset even with no
    // Fault once ~130+ connect at once, which would pollute every run with
    // load-generator noise indistinguishable from Fault-induced failures.
    concurrency: 60,
    fault: "backend-kill",
    killScope: "in-transaction",
    surviveUncaught: false,
    killIntervalMs: 40,
    killFraction: 0.5,
    db: "shared",
    expectViolations: false,
    label: "",
    appPort: 3100,
    proxyPort: 5434,
  };
  const oneOf = <T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T => {
    if (!allowed.includes(value as T)) {
      throw new Error(`${flag} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
    }
    return value as T;
  };
  const posInt = (flag: string, value: string | undefined): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--strategy") args.strategy = String(argv[++i]);
    else if (flag === "--load") args.load = oneOf("--load", argv[++i], ["deadlock-pairs", "hammer-seat", "spread-seats"]);
    else if (flag === "--concurrency") args.concurrency = posInt(flag, argv[++i]);
    else if (flag === "--fault") args.fault = oneOf("--fault", argv[++i], ["backend-kill", "idle-pool-kill", "none"]);
    else if (flag === "--kill-scope") args.killScope = oneOf("--kill-scope", argv[++i], ["in-transaction", "idle", "any"]);
    else if (flag === "--survive-uncaught") args.surviveUncaught = true;
    else if (flag === "--kill-interval-ms") args.killIntervalMs = posInt(flag, argv[++i]);
    else if (flag === "--kill-fraction") {
      const f = Number(argv[++i]);
      if (!(f > 0 && f <= 1)) throw new Error(`--kill-fraction must be in (0, 1], got ${f}`);
      args.killFraction = f;
    } else if (flag === "--db") args.db = oneOf("--db", argv[++i], ["shared", "scratch-no-unique"]);
    else if (flag === "--expect-violations") args.expectViolations = true;
    else if (flag === "--label") args.label = String(argv[++i]);
    else if (flag === "--app-port") args.appPort = posInt(flag, argv[++i]);
    else if (flag === "--proxy-port") args.proxyPort = posInt(flag, argv[++i]);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withPort(connectionString: string, port: number): string {
  const url = new URL(connectionString);
  url.port = String(port);
  return url.toString();
}

// --- seeding & ledger -------------------------------------------------------

interface LedgerEntry extends BookingIntent {
  userId: string;
}

interface SeededLoad {
  eventId: string;
  k6Script: string;
  k6Env: (runId: string) => Record<string, string>;
  ledger: (runId: string) => LedgerEntry[];
}

async function seedSeats(db: Pool, eventName: string, labelPrefix: string, n: number): Promise<{ eventId: string; seatIds: string[] }> {
  const eventRes = await db.query<{ id: string }>("INSERT INTO events (name) VALUES ($1) RETURNING id", [eventName]);
  const eventId = eventRes.rows[0]!.id;
  const seats = await db.query<{ id: string }>(
    `INSERT INTO seats (event_id, label) SELECT $1, $2 || gs FROM generate_series(1, $3) AS gs RETURNING id`,
    [eventId, labelPrefix, n],
  );
  return { eventId, seatIds: seats.rows.map((row) => row.id) };
}

// Each ledger mirrors exactly how its existing k6 script names its requests
// (`${RUN_ID}-${__VU}`, `load-user-${__VU}`, which seats VU n asks for) —
// re-derived here rather than read back from k6, because the whole point of
// the ledger is a record of intent that doesn't depend on anything the Fault
// could have damaged.
async function seedLoad(db: Pool, args: Args): Promise<SeededLoad> {
  const scripts = new URL("../", import.meta.url);
  const script = (name: string) => fileURLToPath(new URL(name, scripts));

  if (args.load === "deadlock-pairs") {
    const { eventId, seatIds } = await seedSeats(db, "Chaos: Deadlock Pairs", "D", args.concurrency * 2);
    const pairs: [string, string][] = [];
    for (let i = 0; i < seatIds.length; i += 2) pairs.push([seatIds[i]!, seatIds[i + 1]!]);
    return {
      eventId,
      k6Script: script("deadlock-pairs.k6.js"),
      k6Env: (runId) => ({ RUN_ID: runId, SEAT_PAIRS: JSON.stringify(pairs) }),
      ledger: (runId) =>
        pairs.flatMap(([a, b], p) => [
          { idempotencyKey: `${runId}-${2 * p + 1}`, userId: `load-user-${2 * p + 1}`, seatIds: [a, b] },
          { idempotencyKey: `${runId}-${2 * p + 2}`, userId: `load-user-${2 * p + 2}`, seatIds: [b, a] },
        ]),
    };
  }

  if (args.load === "spread-seats") {
    const { eventId, seatIds } = await seedSeats(db, "Chaos: Spread Across Seats", "S", args.concurrency);
    return {
      eventId,
      k6Script: script("spread-across-seats.k6.js"),
      k6Env: (runId) => ({ RUN_ID: runId, SEAT_IDS: JSON.stringify(seatIds) }),
      ledger: (runId) =>
        seatIds.map((seatId, i) => ({ idempotencyKey: `${runId}-${i + 1}`, userId: `load-user-${i + 1}`, seatIds: [seatId] })),
    };
  }

  const { eventId, seatIds } = await seedSeats(db, "Chaos: Hammer One Seat", "A", 1);
  return {
    eventId,
    k6Script: script("hammer-seat.k6.js"),
    k6Env: (runId) => ({ RUN_ID: runId, SEAT_ID: seatIds[0]!, CONCURRENCY: String(args.concurrency) }),
    ledger: (runId) =>
      Array.from({ length: args.concurrency }, (_, i) => ({
        idempotencyKey: `${runId}-${i + 1}`,
        userId: `load-user-${i + 1}`,
        seatIds: [seatIds[0]!],
      })),
  };
}

// --- the application under test ---------------------------------------------

interface AppExit {
  at: string;
  code: number | null;
  signal: string | null;
}

// Runs src/server.ts exactly as an operator would (`tsx src/server.ts`), as a
// child process the harness can watch for crashes. Never imports src/: the
// app under test must be the unmodified production entry point, not an
// in-process copy sharing the harness's module state.
class AppUnderTest {
  private child: ChildProcess | undefined;
  private stopping = false;
  readonly exits: AppExit[] = [];
  restarts = 0;
  readonly output: string[] = [];

  constructor(
    private readonly env: Record<string, string>,
    private readonly port: number,
  ) {}

  async start(): Promise<void> {
    const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
    const cwd = fileURLToPath(new URL("../../", import.meta.url));
    const child = spawn(tsx, ["src/server.ts"], {
      cwd,
      env: { ...process.env, ...this.env, PORT: String(this.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const capture = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim() !== "" && this.output.length < 20000) this.output.push(line);
      }
    };
    child.stdout!.on("data", capture);
    child.stderr!.on("data", capture);
    child.on("exit", (code, signal) => {
      if (this.stopping || this.child !== child) return;
      this.exits.push({ at: new Date().toISOString(), code, signal });
      // The harness plays process supervisor: bring it back after a short
      // delay so the run continues and recovery can be judged. The crash is
      // already on record in `exits`.
      this.restarts += 1;
      setTimeout(() => {
        if (!this.stopping) this.start().catch((err) => console.error("app restart failed:", err));
      }, 300);
    });
    await this.waitReady();
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${this.port}/seats`);
        await res.arrayBuffer();
        return; // any HTTP response (here a 400 for the missing query param) means it's listening
      } catch {
        await sleep(150);
      }
    }
    throw new Error(`App did not become ready on :${this.port} within 30s`);
  }

  // After the Fault clears: wait for the supervisor-restart (if one is
  // pending) to bring the app back, then confirm it answers.
  async ensureUp(): Promise<void> {
    await this.waitReady();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

// --- k6 -----------------------------------------------------------------------

interface K6Outcome {
  exitCode: number | null;
  durationMs: number;
  requests: number;
  statusTally: Record<string, number>;
  // k6's own reason for each status-0 request ("connection refused", "EOF", ...).
  transportErrors: Record<string, number>;
  maxRequestMs: number;
}

// Parsed from k6's per-point JSON output rather than its summary, because the
// summary only tallies what the script's own Counters bucket (201/409/503/
// other) — under a Fault the distinction that matters is among the "other"s:
// a 500 (server answered with an error), a 0 (no answer: connection refused/
// reset/timeout), and a request that simply took very long.
async function runK6(script: string, env: Record<string, string>, appPort: number): Promise<K6Outcome> {
  await mkdir(new URL("../../docs/evidence/chaos/", import.meta.url), { recursive: true });
  const outPath = fileURLToPath(new URL(`../../docs/evidence/chaos/.k6-points-${randomUUID()}.json`, import.meta.url));
  const startedAt = Date.now();
  const child = spawn("k6", ["run", "--quiet", "--summary-mode=disabled", "--log-output=none", `--out=json=${outPath}`, script], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, BASE_URL: `http://localhost:${appPort}`, ...env },
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", (err) =>
      reject(new Error(`Failed to run k6 (is it installed? \`brew install k6\`): ${err.message}`)),
    );
    child.on("exit", (code) => resolve(code));
  });
  const durationMs = Date.now() - startedAt;
  // k6 exits nonzero only for its own failures here (the load scripts define
  // no thresholds, so failed checks under a Fault don't count): a nonzero
  // exit means the load didn't run as specified and the run is void.
  if (exitCode !== 0) {
    throw new Error(`k6 exited with status ${exitCode}`);
  }

  const statusTally: Record<string, number> = {};
  const transportErrors: Record<string, number> = {};
  let requests = 0;
  let maxRequestMs = 0;
  const raw = await readFile(outPath, "utf8");
  await rm(outPath);
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const point = JSON.parse(line) as {
      type: string;
      metric: string;
      data: { value: number; tags?: Record<string, string> };
    };
    if (point.type !== "Point") continue;
    if (point.metric === "http_reqs") {
      requests += 1;
      const status = point.data.tags?.status ?? "?";
      statusTally[status] = (statusTally[status] ?? 0) + 1;
      // A status-0 request never got an HTTP answer; k6 names why.
      const error = point.data.tags?.error;
      if (status === "0" && error) transportErrors[error] = (transportErrors[error] ?? 0) + 1;
    } else if (point.metric === "http_req_duration") {
      maxRequestMs = Math.max(maxRequestMs, point.data.value);
    }
  }
  return { exitCode, durationMs, requests, statusTally, transportErrors, maxRequestMs };
}

// --- recovery replay ----------------------------------------------------------

async function replayLedger(
  appPort: number,
  ledger: LedgerEntry[],
): Promise<{ tally: Record<string, number>; networkErrors: number }> {
  const tally: Record<string, number> = {};
  let networkErrors = 0;
  let next = 0;
  const worker = async () => {
    while (next < ledger.length) {
      const entry = ledger[next++]!;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const res = await fetch(`http://localhost:${appPort}/bookings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ seat_ids: entry.seatIds, user_id: entry.userId, idempotency_key: entry.idempotencyKey }),
          });
          await res.arrayBuffer();
          tally[res.status] = (tally[res.status] ?? 0) + 1;
          break;
        } catch {
          if (attempt >= 2) {
            networkErrors += 1;
            break;
          }
          await sleep(200);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  return { tally, networkErrors };
}

// --- findings -----------------------------------------------------------------

// Collapses a captured app log into counts of distinct error headlines (the
// non-stack-trace lines), so a run's report can say *which* errors the app
// logged and how often without embedding thousands of near-identical lines.
function errorSignatures(output: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of output) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("at ") || trimmed.startsWith("RaceToSeat listening")) continue;
    if (!/error|exception|terminat|not queryable|ECONN|unhandled|fatal/i.test(trimmed)) continue;
    const key = trimmed.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>").slice(0, 200);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

interface RobustnessObservation {
  id: string;
  detail: string;
}

function deriveRobustnessObservations(app: AppUnderTest, k6: K6Outcome): RobustnessObservation[] {
  const found: RobustnessObservation[] = [];
  if (app.exits.length > 0) {
    found.push({
      id: "app-process-crashed",
      detail: `the app process exited ${app.exits.length} time(s) during the run (${app.exits.map((e) => `code=${e.code} signal=${e.signal}`).join("; ")})`,
    });
  }
  const serverErrors = Object.entries(k6.statusTally).filter(([s]) => s.startsWith("5") && s !== "503");
  if (serverErrors.length > 0) {
    found.push({
      id: "unclassified-server-errors",
      detail: `requests answered with ${serverErrors.map(([s, n]) => `${n}x HTTP ${s}`).join(", ")} (not a designed outcome — only 201/409/404/503 are)`,
    });
  }
  const noAnswer = k6.statusTally["0"] ?? 0;
  if (noAnswer > 0) {
    found.push({
      id: "requests-without-answer",
      detail: `${noAnswer} request(s) got no HTTP response (connection refused/reset/timeout)`,
    });
  }
  if (k6.maxRequestMs > 10_000) {
    found.push({
      id: "slow-or-hung-request",
      detail: `slowest request took ${Math.round(k6.maxRequestMs)}ms (> 10s)`,
    });
  }
  return found;
}

// --- main ---------------------------------------------------------------------

function printOracles(results: OracleResult[]): void {
  for (const r of results) {
    console.log(`  Oracle ${r.oracle} (${r.name}): ${r.passed ? "PASS" : `FAIL — ${r.violations.length} violation(s)`}`);
    for (const v of r.violations.slice(0, 5)) console.log(`      - [${v.kind}] ${v.detail}`);
    if (r.violations.length > 5) console.log(`      ... and ${r.violations.length - 5} more`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is required (direct Postgres, e.g. localhost:5433)");

  let scratch: ScratchDb | undefined;
  let db: Pool;
  let targetUrl = baseUrl;
  if (args.db === "scratch-no-unique") {
    // ADR-0023: weaken the *database*, not the code — a scratch copy of the
    // real schema with the UNIQUE(seat_id) backstops (ADR-0008) dropped.
    scratch = await createScratchDb(baseUrl, SEAT_UNIQUE_CONSTRAINTS);
    targetUrl = scratch.connectionString;
    db = scratch.pool;
    console.log(`Scratch database ${scratch.name} created (schema.sql minus booking_seats/hold_seats UNIQUE(seat_id)).`);
  } else {
    db = chaosPool(baseUrl);
  }

  const appUrl = withPort(targetUrl, args.proxyPort);
  let app: AppUnderTest | undefined;
  try {
    // The proxy must be up: chaos runs go app -> Toxiproxy -> Postgres.
    const probe = new Pool({ connectionString: appUrl, max: 1, connectionTimeoutMillis: 3000 });
    try {
      await probe.query("SELECT 1");
    } catch (err) {
      throw new Error(
        `Cannot reach Postgres through Toxiproxy at port ${args.proxyPort} (${(err as Error).message}). ` +
          "Start it with: docker compose --profile chaos up -d",
      );
    } finally {
      await probe.end();
    }

    const settingsRes = await db.query<{ name: string; setting: string }>(
      `SELECT name, setting FROM pg_settings
       WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout','idle_session_timeout','tcp_keepalives_idle')`,
    );
    const serverTimeouts = Object.fromEntries(settingsRes.rows.map((r) => [r.name, r.setting]));

    const seeded = await seedLoad(db, args);
    const runId = randomUUID();
    const ledger = seeded.ledger(runId);

    const appEnv: Record<string, string> = { DATABASE_URL: appUrl, BOOKING_STRATEGY: args.strategy };
    if (args.surviveUncaught) {
      const preload = fileURLToPath(new URL("./survive-uncaught.mjs", import.meta.url));
      appEnv.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import ${preload}`.trim();
    }
    app = new AppUnderTest(appEnv, args.appPort);
    await app.start();
    console.log(`App started (strategy=${args.strategy}, :${args.appPort} -> proxy :${args.proxyPort}).`);

    const ranAt = new Date();
    console.log(`Firing ${args.load} load (${ledger.length} requests) with fault=${args.fault}...`);
    const killer =
      args.fault === "backend-kill"
        ? startBackendKiller(db, { intervalMs: args.killIntervalMs, fraction: args.killFraction, scope: args.killScope })
        : undefined;
    let k6: K6Outcome;
    let killStats: BackendKillStats | undefined;
    try {
      k6 = await runK6(seeded.k6Script, seeded.k6Env(runId), args.appPort);
    } finally {
      killStats = await killer?.stop();
    }
    if (args.fault === "idle-pool-kill") {
      // Hypothesis 1's literal scenario: a pooled connection that is idle (not
      // checked out) dies. Only reachable once the load has drained and its
      // clients have been released back to the pool, so it is a one-shot
      // after the load rather than a sweep during it.
      await sleep(500);
      killStats = await killBackendsOnceWithStats(db, { fraction: 1, scope: "idle" });
      await sleep(1000);
    }
    console.log(`Load finished in ${k6.durationMs}ms; k6 statuses: ${JSON.stringify(k6.statusTally)}.`);
    if (killStats) console.log(`Fault: ${killStats.terminated} backend(s) terminated over ${killStats.sweeps} sweeps ${JSON.stringify(killStats.terminatedByState)}.`);

    // Fault cleared. Let the dust settle, then make sure the app is back.
    await sleep(1500);
    await app.ensureUp();

    const keys = ledger.map((e) => e.idempotencyKey);
    const before = await snapshotBookingsByKey(db, keys);
    console.log("Replaying every Idempotency Key...");
    const replay = await replayLedger(args.appPort, ledger);
    console.log(`Replay statuses: ${JSON.stringify(replay.tally)}${replay.networkErrors ? `, ${replay.networkErrors} unreachable` : ""}.`);
    await sleep(500);

    const oracles = await runOracles(db, { scope: { eventId: seeded.eventId }, ledger, before });
    printOracles(oracles);

    const correctnessViolation = oracles.some((o) => !o.passed);
    const robustness = deriveRobustnessObservations(app, k6);
    for (const r of robustness) console.log(`  Robustness observation [${r.id}]: ${r.detail}`);

    const label = args.label || `${args.strategy}-${args.load}-${args.fault}${args.surviveUncaught ? "-survive" : ""}${args.db === "scratch-no-unique" ? "-scratch" : ""}`;
    const stamp = ranAt.toISOString().replace(/[:.]/g, "-");
    const report = {
      label,
      ranAt: ranAt.toISOString(),
      args,
      eventId: seeded.eventId,
      requestsIssued: ledger.length,
      fault: { kind: args.fault, scope: args.killScope, intervalMs: args.killIntervalMs, fraction: args.killFraction, stats: killStats },
      k6: { statusTally: k6.statusTally, transportErrors: k6.transportErrors, durationMs: k6.durationMs, maxRequestMs: Math.round(k6.maxRequestMs) },
      app: { exits: app.exits, restarts: app.restarts, errorSignatures: errorSignatures(app.output) },
      replay,
      serverTimeouts,
      oracles,
      correctnessViolation,
      robustnessObservations: robustness,
    };
    const outDir = new URL("../../docs/evidence/chaos/", import.meta.url);
    await mkdir(outDir, { recursive: true });
    const outPath = new URL(`${label}-${stamp}.json`, outDir);
    await writeFile(outPath, JSON.stringify(report, null, 2));
    await writeFile(new URL(`${label}-${stamp}.app.log`, outDir), app.output.slice(0, 2000).join("\n") + "\n");
    console.log(`\nReport written to ${outPath.pathname}`);

    if (args.expectViolations) {
      if (!correctnessViolation) {
        console.error("\n*** NEGATIVE CONTROL FAILED: the Oracles flagged nothing on a run that should have violated a guarantee. ***");
        process.exitCode = 1;
      } else {
        console.log("\nNegative control OK: the Oracles flagged the violation.");
      }
    } else if (correctnessViolation) {
      console.error("\n*** CORRECTNESS VIOLATION: at least one Oracle failed. ***");
      process.exitCode = 1;
    } else {
      console.log("\nAll four Oracles passed.");
    }
  } finally {
    await app?.stop();
    if (scratch) await scratch.drop();
    else await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
