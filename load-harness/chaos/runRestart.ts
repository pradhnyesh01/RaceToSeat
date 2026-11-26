// Chaos harness, Postgres-restart edition (issue #51, C4, ADR-0032): applies
// load to the unmodified app while the Postgres SERVER underneath it is
// restarted or SIGKILLed, then judges stored state with the four Oracles of
// oracles.ts plus Oracle 5, durability of acknowledged work (durabilityOracle.ts).
//
// What is different from run.ts / runHolds.ts, and why:
//   * The run owns its Postgres. Restarting a server takes every database on
//     it down, so this never shares one: a `c4-pg-<hex>` container is created,
//     faulted and removed by this process, and every destructive docker command
//     is preceded by an ownership check (restartFault.ts). It never touches the
//     repo's compose database or any container it did not create.
//   * The app talks straight to that Postgres (no Toxiproxy): the Fault is the
//     server's own process, not the link.
//   * The load is a sustained Node client (restartLoad.ts), not k6: it has to
//     outlast the restart and it must record the Booking id of every 201.
//   * The durability Oracle runs BEFORE the Idempotency-Key replay (a replay
//     would re-create a lost Booking and hide it), the other four after, as in
//     every other chaos run.
//
// Exit status: nonzero iff an Oracle failed (a Correctness violation), inverted
// by --expect-violations for the negative control (ADR-0023): there the run
// FAILS if the Oracles flagged nothing.
//
// Usage: tsx load-harness/chaos/runRestart.ts [--variant restart|stop|kill|none]
//   [--load spread|hammer|holds] [--profile safe|unsafe] [--strategy pessimistic]
//   [--seats 4000] [--workers 30] [--think-ms 60] [--trigger-fraction 0.3]
//   [--down-ms 3000] [--confirm-fraction 0.5] [--hold-ttl-seconds 15]
//   [--reaper-interval-ms 1000] [--retry-deadline-ms 60000] [--attempt-timeout-ms 8000]
//   [--expect-violations] [--label name] [--app-port 3400]
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import "dotenv/config";
import "./placeholderEnv.js";
import { confirmIdempotencyKey } from "../../src/strategies/pessimisticConfirm.js";
import { checkAcknowledgedDurability } from "./durabilityOracle.js";
import { runOracles, snapshotBookingsByKey, type OracleResult } from "./oracles.js";
import { startLoad, type LoadKind, type LoadResult, type RequestEvent } from "./restartLoad.js";
import { ScratchPostgres, type DurabilityProfile, type FaultTimeline, type RestartVariant } from "./restartFault.js";
import { AppUnderTest, errorSignatures, printOracles, replayLedger, sleep, type LedgerEntry } from "./run.js";
import { chaosPool } from "./scratchDb.js";
import { waitForDrain, type DrainResult } from "./stallSampler.js";

interface Args {
  variant: RestartVariant | "none";
  load: LoadKind;
  profile: DurabilityProfile;
  strategy: string;
  seats: number;
  workers: number;
  thinkMs: number;
  triggerFraction: number;
  downMs: number;
  confirmFraction: number;
  holdTtlSeconds: number;
  reaperIntervalMs: number;
  retryDeadlineMs: number;
  attemptTimeoutMs: number;
  drainTimeoutMs: number;
  expectViolations: boolean;
  label: string;
  appPort: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    variant: "restart",
    load: "spread",
    profile: "safe",
    strategy: "pessimistic",
    seats: 4000,
    workers: 30,
    thinkMs: 60,
    triggerFraction: 0.3,
    downMs: 3000,
    confirmFraction: 0.5,
    holdTtlSeconds: 15,
    reaperIntervalMs: 1000,
    retryDeadlineMs: 60_000,
    attemptTimeoutMs: 8000,
    drainTimeoutMs: 30_000,
    expectViolations: false,
    label: "",
    appPort: 3400,
  };
  const oneOf = <T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T => {
    if (!allowed.includes(value as T)) throw new Error(`${flag} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
    return value as T;
  };
  const int = (flag: string, value: string | undefined, min = 1): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}, got ${JSON.stringify(value)}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--variant") args.variant = oneOf(flag, argv[++i], ["restart", "stop", "kill", "none"]);
    else if (flag === "--load") args.load = oneOf(flag, argv[++i], ["spread", "hammer", "holds"]);
    else if (flag === "--profile") args.profile = oneOf(flag, argv[++i], ["safe", "unsafe"]);
    else if (flag === "--strategy") args.strategy = String(argv[++i]);
    else if (flag === "--seats") args.seats = int(flag, argv[++i]);
    else if (flag === "--workers") args.workers = int(flag, argv[++i]);
    else if (flag === "--think-ms") args.thinkMs = int(flag, argv[++i], 0);
    else if (flag === "--trigger-fraction") {
      const f = Number(argv[++i]);
      if (!(f > 0 && f < 1)) throw new Error(`--trigger-fraction must be in (0, 1), got ${f}`);
      args.triggerFraction = f;
    } else if (flag === "--down-ms") args.downMs = int(flag, argv[++i], 0);
    else if (flag === "--confirm-fraction") args.confirmFraction = Number(argv[++i]);
    else if (flag === "--hold-ttl-seconds") args.holdTtlSeconds = int(flag, argv[++i]);
    else if (flag === "--reaper-interval-ms") args.reaperIntervalMs = int(flag, argv[++i]);
    else if (flag === "--retry-deadline-ms") args.retryDeadlineMs = int(flag, argv[++i]);
    else if (flag === "--attempt-timeout-ms") args.attemptTimeoutMs = int(flag, argv[++i]);
    else if (flag === "--drain-timeout-ms") args.drainTimeoutMs = int(flag, argv[++i]);
    else if (flag === "--expect-violations") args.expectViolations = true;
    else if (flag === "--label") args.label = String(argv[++i]);
    else if (flag === "--app-port") args.appPort = int(flag, argv[++i]);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (args.load === "holds" && args.strategy !== "pessimistic") throw new Error("--load holds needs --strategy pessimistic (ADR-0017/0019)");
  return args;
}

// The harness's own pools get a no-op 'error' handler: pg emits it for an idle
// connection the server closed, and without a listener that crashes the
// harness itself the first time the server restarts.
function quietPool(connectionString: string, max = 5): Pool {
  const pool = chaosPool(connectionString, max);
  pool.on("error", () => undefined);
  return pool;
}

async function seed(db: Pool, load: LoadKind, seats: number): Promise<{ eventId: string; seatIds: string[] }> {
  const ev = await db.query<{ id: string }>("INSERT INTO events (name) VALUES ($1) RETURNING id", [`C4 restart: ${load}`]);
  const eventId = ev.rows[0]!.id;
  const rows = await db.query<{ id: string }>(
    "INSERT INTO seats (event_id, label) SELECT $1, 'R' || gs FROM generate_series(1, $2) AS gs RETURNING id",
    [eventId, seats],
  );
  return { eventId, seatIds: rows.rows.map((r) => r.id) };
}

const countLines = (lines: string[], needle: string) => lines.filter((l) => l.includes(needle)).length;

interface WindowTally {
  before: Record<string, number>;
  during: Record<string, number>;
  after: Record<string, number>;
}

const bucket = (e: RequestEvent) => (e.status === 0 ? `none:${e.error ?? "?"}` : String(e.status));

// Splits every attempt by when it finished relative to the Fault: before the
// command, while the server was down/restarting (command start to server
// reachable), after.
export function tallyWindows(events: RequestEvent[], faultStartMs: number | undefined, dbBackMs: number | null | undefined): WindowTally {
  const out: WindowTally = { before: {}, during: {}, after: {} };
  for (const e of events) {
    const w =
      faultStartMs === undefined ? "before" : e.doneAtMs < faultStartMs ? "before" : dbBackMs != null && e.doneAtMs > dbBackMs ? "after" : "during";
    out[w][bucket(e)] = (out[w][bucket(e)] ?? 0) + 1;
  }
  return out;
}

export interface RecoveryMetrics {
  // Last 201 completed before the Fault, first 201 completed after the server was reachable again.
  lastCreatedBeforeFaultMs: number | null;
  firstCreatedAfterDbBackMs: number | null;
  // How long past "server reachable again" the app took to answer a 201 (the app's own recovery lag).
  appLagAfterDbBackMs: number | null;
  // Client-visible write outage: last 201 before the Fault to the first 201 after recovery.
  writeOutageMs: number | null;
  // First attempt after the Fault began that did not get an ordinary 201/409/etc. answer.
  firstFailureAfterFaultMs: number | null;
}

export function recoveryMetrics(events: RequestEvent[], tl: FaultTimeline | undefined): RecoveryMetrics {
  const none: RecoveryMetrics = { lastCreatedBeforeFaultMs: null, firstCreatedAfterDbBackMs: null, appLagAfterDbBackMs: null, writeOutageMs: null, firstFailureAfterFaultMs: null };
  if (!tl || tl.dbBackAtMs === null) return none;
  const created = events.filter((e) => e.status === 201);
  const before = created.filter((e) => e.doneAtMs < tl.commandStartedAtMs);
  const after = created.filter((e) => e.doneAtMs >= tl.dbBackAtMs!);
  const lastBefore = before.length ? Math.max(...before.map((e) => e.doneAtMs)) : null;
  const firstAfter = after.length ? Math.min(...after.map((e) => e.doneAtMs)) : null;
  const failure = events.filter((e) => e.doneAtMs >= tl.commandStartedAtMs && (e.status === 0 || e.status >= 500));
  return {
    lastCreatedBeforeFaultMs: lastBefore,
    firstCreatedAfterDbBackMs: firstAfter,
    appLagAfterDbBackMs: firstAfter === null ? null : Math.max(0, firstAfter - tl.dbBackAtMs),
    writeOutageMs: lastBefore !== null && firstAfter !== null ? firstAfter - lastBefore : null,
    firstFailureAfterFaultMs: failure.length ? Math.min(...failure.map((e) => e.doneAtMs)) - tl.commandStartedAtMs : null,
  };
}

export interface ReaperWatch {
  // Seats that were 'held' and already past held_until at the moment the harness first saw the server back.
  expiredPendingAtRecovery: number;
  // ms until none of those seats was 'held' any more (null: not within 30 s).
  clearedAfterMs: number | null;
}

// Started the moment the server answers again, while the load is still running:
// how long does the reaper take to clear the backlog of holds that expired while
// it could not reach the database? (Holds that expire later are not part of this
// number; the end-of-run check covers those.)
async function watchReaperCatchUp(url: string, eventId: string, clock: () => number): Promise<ReaperWatch> {
  const db = quietPool(url, 1);
  try {
    const start = clock();
    const pending = await db.query<{ id: string }>(
      "SELECT id FROM seats WHERE event_id = $1 AND status = 'held' AND held_until < now()",
      [eventId],
    );
    const ids = pending.rows.map((r) => r.id);
    if (ids.length === 0) return { expiredPendingAtRecovery: 0, clearedAfterMs: 0 };
    while (clock() - start < 30_000) {
      const left = await db.query<{ n: string }>("SELECT count(*) AS n FROM seats WHERE id = ANY($1) AND status = 'held'", [ids]);
      if (Number(left.rows[0]!.n) === 0) return { expiredPendingAtRecovery: ids.length, clearedAfterMs: clock() - start };
      await sleep(50);
    }
    return { expiredPendingAtRecovery: ids.length, clearedAfterMs: null };
  } finally {
    await db.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pg = new ScratchPostgres(args.profile);
  let app: AppUnderTest | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await app?.stop().catch(() => undefined);
    await pg.remove();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      cleanup().finally(() => process.exit(130));
    });
  }

  try {
    console.log("Starting scratch Postgres...");
    await pg.start();
    const settings = {
      synchronous_commit: await pg.setting("synchronous_commit"),
      fsync: await pg.setting("fsync"),
      wal_writer_delay: await pg.setting("wal_writer_delay"),
      stopSignal: await pg.stopSignal(),
    };
    console.log(`Scratch Postgres ${pg.name} on 127.0.0.1:${pg.hostPort} (profile=${args.profile}: ${JSON.stringify(settings)}).`);

    // Schema + seed + CHECKPOINT: under the unsafe profile the seed itself would
    // otherwise sit in memory too, and the control would lose its own fixtures
    // instead of the acknowledged Bookings it is about.
    let eventId: string;
    let seatIds: string[];
    {
      const setup = quietPool(pg.url, 2);
      try {
        await setup.query(await readFile(fileURLToPath(new URL("../../db/schema.sql", import.meta.url)), "utf8"));
        ({ eventId, seatIds } = await seed(setup, args.load, args.seats));
        await setup.query("CHECKPOINT");
      } finally {
        await setup.end();
      }
    }

    const appName = `c4-app-${pg.runTag}`;
    const appUrl = new URL(pg.url);
    appUrl.searchParams.set("application_name", appName);
    app = new AppUnderTest(
      {
        DATABASE_URL: appUrl.toString(),
        BOOKING_STRATEGY: args.strategy,
        HOLD_TTL_SECONDS: String(args.holdTtlSeconds),
        REAPER_INTERVAL_MS: String(args.reaperIntervalMs),
      },
      args.appPort,
    );
    await app.start();
    console.log(`App started (strategy=${args.strategy}, :${args.appPort}).`);

    const runId = randomUUID();
    const t0 = Date.now();
    const clock = () => Date.now() - t0;
    const hammerRounds = seatIds.length;
    const totalOps = seatIds.length;
    const load = startLoad(
      {
        kind: args.load,
        runId,
        baseUrl: `http://localhost:${args.appPort}`,
        seatIds,
        workers: args.workers,
        thinkMs: args.thinkMs,
        confirmFraction: args.confirmFraction,
        retryDeadlineMs: args.retryDeadlineMs,
        attemptTimeoutMs: args.attemptTimeoutMs,
      },
      clock,
    );
    const triggerAt = Math.max(1, Math.floor((args.load === "hammer" ? hammerRounds : totalOps) * args.triggerFraction));
    console.log(`Load ${args.load}: ${args.workers} workers over ${seatIds.length} seats; fault=${args.variant} after ${triggerAt} acknowledged.`);

    let timeline: FaultTimeline | undefined;
    let acksAtFault = 0;
    let reaperWatch: ReaperWatch | undefined;
    const faultDone = (async () => {
      if (args.variant === "none") return;
      await load.whenAcked(triggerAt);
      acksAtFault = load.ackCount();
      console.log(`Applying fault: ${args.variant} (${acksAtFault} acknowledged so far, t=${clock()}ms)...`);
      timeline = await pg.applyFault(args.variant, args.downMs, clock);
      if (args.load === "holds") reaperWatch = await watchReaperCatchUp(pg.url, eventId, clock);
    })();
    const loadResult: LoadResult = await load.done;
    await faultDone;
    const loadFinishedAtMs = clock();
    console.log(
      `Load finished at ${loadFinishedAtMs}ms: ${JSON.stringify(loadResult.finals)}, ${loadResult.abandoned} abandoned, ` +
        `${loadResult.events.length} attempts.` +
        (timeline ? ` Server unreachable ${timeline.unreachableMs}ms (command ${timeline.commandReturnedAtMs - timeline.commandStartedAtMs}ms).` : ""),
    );

    // From here the harness reads state through connections of its own, opened
    // after the server was back.
    const db = quietPool(pg.url, 5);
    try {
      const drain: DrainResult = await waitForDrain(db, appName, args.drainTimeoutMs);
      console.log(`Drain: ${drain.timedOut ? `TIMED OUT (${drain.stuck.length} stuck)` : `${drain.drainedAfterMs}ms`}.`);

      // --- Oracle 5, BEFORE the replay (which would re-create a lost Booking
      // and hide it) and, for Holds, before they are allowed to expire (an
      // expired Hold is a legitimate reason for one to be gone).
      const durability: OracleResult = await checkAcknowledgedDurability(
        db,
        { eventId },
        args.load === "holds" ? { holds: loadResult.ackedHolds } : { bookings: loadResult.ackedBookings },
      );

      // Hold lifecycle: let every hold run past its expiry, then see how long
      // the reaper takes to put the unconfirmed ones' seats back.
      let reaperCaughtUpMs: number | null = null;
      let holdsStillHeld: number | null = null;
      if (args.load === "holds") {
        const maxHeld = Math.max(...loadResult.ackedHolds.map((h) => Date.parse(h.heldUntil)), 0);
        const waitMs = Math.max(0, maxHeld - Date.now());
        console.log(`Waiting ${waitMs}ms for the last hold to expire...`);
        await sleep(waitMs);
        const start = Date.now();
        for (;;) {
          const r = await db.query<{ n: string }>("SELECT count(*) AS n FROM seats WHERE event_id = $1 AND status = 'held'", [eventId]);
          holdsStillHeld = Number(r.rows[0]!.n);
          if (holdsStillHeld === 0) {
            reaperCaughtUpMs = Date.now() - start;
            break;
          }
          if (Date.now() - start > 30_000) break;
          await sleep(100);
        }
        console.log(`Reaper: ${reaperCaughtUpMs === null ? `${holdsStillHeld} seat(s) still held after 30s` : `every expired hold released ${reaperCaughtUpMs}ms after the last expiry`}.`);
      }

      // --- recovery replay, then Oracles 1-4 ---
      let ledger: LedgerEntry[];
      if (args.load === "holds") {
        ledger = loadResult.ackedHolds.map((h) => ({ idempotencyKey: confirmIdempotencyKey(h.holdId), userId: h.userId, seatIds: h.seatIds }));
      } else {
        ledger = loadResult.intents;
      }
      const keys = ledger.map((e) => e.idempotencyKey);
      const before = await snapshotBookingsByKey(db, keys);
      const committedBeforeReplay = Object.values(before).reduce((n, rows) => n + rows.length, 0);
      const answered201 = args.load === "holds" ? loadResult.ackedHolds.filter((h) => h.confirmedBookingId).length : loadResult.ackedBookings.length;
      const ambiguity = { bookingsCommittedBeforeReplay: committedBeforeReplay, bookingsAnsweredWith201: answered201, committedUnacknowledged: Math.max(0, committedBeforeReplay - answered201) };

      let replay: { tally: Record<string, number>; networkErrors: number };
      if (args.load === "holds") {
        // A Hold's recovery action is retrying its Confirm.
        const tally: Record<string, number> = {};
        let networkErrors = 0;
        for (const h of loadResult.ackedHolds) {
          try {
            const res = await fetch(`http://localhost:${args.appPort}/holds/${h.holdId}/confirm`, { method: "POST", signal: AbortSignal.timeout(20_000) });
            await res.arrayBuffer();
            tally[res.status] = (tally[res.status] ?? 0) + 1;
          } catch {
            networkErrors += 1;
          }
        }
        replay = { tally, networkErrors };
      } else {
        replay = await replayLedger(args.appPort, ledger);
      }
      console.log(`Replay statuses: ${JSON.stringify(replay.tally)}${replay.networkErrors ? `, ${replay.networkErrors} unreachable` : ""}.`);
      await sleep(500);

      const oracles: OracleResult[] = [
        ...(await runOracles(db, { scope: { eventId }, ledger, before })),
        durability,
      ];
      printOracles(oracles);

      const correctnessViolation = oracles.some((o) => !o.passed);
      const windows = tallyWindows(loadResult.events, timeline?.commandStartedAtMs, timeline?.dbBackAtMs);
      const recovery = recoveryMetrics(loadResult.events, timeline);
      const slowest = loadResult.events.reduce((m, e) => Math.max(m, e.doneAtMs - e.sentAtMs), 0);
      const reaperSweepFailures = countLines(app.output, "Reaper sweep failed");

      const robustness: { id: string; detail: string }[] = [];
      if (app.exits.length > 0) robustness.push({ id: "app-process-crashed", detail: `the app process exited ${app.exits.length} time(s) (${app.exits.map((e) => `code=${e.code} signal=${e.signal}`).join("; ")})` });
      if (drain.timedOut) robustness.push({ id: "leaked-transaction-after-fault", detail: `${drain.stuck.length} app transaction(s) still open ${args.drainTimeoutMs}ms after recovery` });
      if (loadResult.abandoned > 0) robustness.push({ id: "requests-abandoned", detail: `${loadResult.abandoned} request(s) never got a definitive answer within ${args.retryDeadlineMs}ms of retrying` });
      const unclassified = Object.values(windows).flatMap((t) => Object.entries(t as Record<string, number>)).filter(([s]) => /^5\d\d$/.test(s) && !["502", "503", "504"].includes(s));
      if (unclassified.length > 0) {
        const merged: Record<string, number> = {};
        for (const [s, n] of unclassified) merged[s] = (merged[s] ?? 0) + n;
        robustness.push({ id: "unclassified-server-errors", detail: `attempts answered ${Object.entries(merged).map(([s, n]) => `${n}x HTTP ${s}`).join(", ")} (not a designed outcome)` });
      }
      if (reaperSweepFailures > 0) robustness.push({ id: "reaper-sweep-failed", detail: `${reaperSweepFailures} reaper sweep(s) failed and were logged (the reaper survived each)` });
      if (args.load === "holds" && reaperCaughtUpMs === null) robustness.push({ id: "reaper-did-not-recover", detail: `${holdsStillHeld} seat(s) still 'held' 30s after the last hold expired` });
      for (const r of robustness) console.log(`  Robustness observation [${r.id}]: ${r.detail}`);

      const label = args.label || `c4-${args.variant}-${args.load}-${args.profile}`;
      const stamp = new Date(t0).toISOString().replace(/[:.]/g, "-");
      const report = {
        label,
        ranAt: new Date(t0).toISOString(),
        args,
        container: { name: pg.name, image: "postgres:17", settings },
        eventId,
        requestsIssued: loadResult.intents.length || loadResult.ackedHolds.length,
        seats: seatIds.length,
        acknowledged: { bookings: loadResult.ackedBookings.length, holds: loadResult.ackedHolds.length, confirms: loadResult.ackedHolds.filter((h) => h.confirmedBookingId).length, atFault: acksAtFault },
        fault: timeline ?? null,
        finals: loadResult.finals,
        abandoned: loadResult.abandoned,
        attempts: loadResult.events.length,
        windows,
        recovery,
        slowestAttemptMs: slowest,
        loadFinishedAtMs,
        drain,
        ambiguity,
        reaper: args.load === "holds" ? { atRecovery: reaperWatch, caughtUpMs: reaperCaughtUpMs, stillHeld: holdsStillHeld, sweepFailures: reaperSweepFailures, intervalMs: args.reaperIntervalMs, holdTtlSeconds: args.holdTtlSeconds } : undefined,
        app: { exits: app.exits, restarts: app.restarts, errorSignatures: errorSignatures(app.output), reaperSweepFailures },
        replay,
        oracles,
        correctnessViolation,
        robustnessObservations: robustness,
      };
      const outDir = new URL("../../docs/evidence/chaos/c4-restart/", import.meta.url);
      await mkdir(outDir, { recursive: true });
      const outPath = new URL(`${label}-${stamp}.json`, outDir);
      await writeFile(outPath, JSON.stringify(report, null, 2));
      await writeFile(new URL(`${label}-${stamp}.app.log`, outDir), app.output.slice(0, 2000).join("\n") + "\n");
      console.log(`\nReport written to ${outPath.pathname}`);

      if (args.expectViolations) {
        if (!correctnessViolation) {
          console.error("\n*** NEGATIVE CONTROL FAILED: the Oracles flagged nothing on a run that should have lost acknowledged work. ***");
          process.exitCode = 1;
        } else {
          console.log(`\nNegative control OK: the Oracles flagged the violation (${oracles.filter((o) => !o.passed).map((o) => `Oracle ${o.oracle}`).join(", ")}).`);
        }
      } else if (correctnessViolation) {
        console.error("\n*** CORRECTNESS VIOLATION: at least one Oracle failed. ***");
        process.exitCode = 1;
      } else {
        console.log("\nAll five Oracles passed.");
      }
    } finally {
      await db.end().catch(() => undefined);
    }
  } finally {
    await cleanup();
  }
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
