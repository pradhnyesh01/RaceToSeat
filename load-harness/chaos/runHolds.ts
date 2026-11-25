// Chaos harness, hold lifecycle edition (issue #50, C3): runs Phase 5's hold
// → confirm → reaper flow (`pessimistic` only, ADR-0017) against a real app
// process while a Fault is injected, then judges stored state with the
// Oracles (ADR-0022) — the four from oracles.ts plus the Hold extensions in
// holdOracles.ts. Sibling of run.ts (which drives bookings); reuses its app
// launcher and k6 runner rather than copying them.
//
// Differences from the bookings harness that matter:
//   * The app, its reaper, the Fault driver and the Oracles all run
//     together. The app is `src/server.ts` unmodified, so the reaper is
//     started exactly as in production (server.ts starts it after listen).
//   * Holds are seeded through the real `POST /holds` (the response shape and
//     the pessimistic hold path only exist behind the API), BEFORE the Fault
//     starts, then snapshotted from the database — the ledger of intent.
//   * ALWAYS a throwaway scratch database holding the full real schema
//     (nothing dropped, unless a negative control asks): this ticket shares
//     the dev Postgres container with sibling sessions, so it never writes to
//     or kills backends in the shared `racetoseat` database.
//   * The app connects straight to Postgres (no Toxiproxy): backend-kill is
//     driven by pg_terminate_backend and doesn't need a proxy. The Fault is
//     scoped three ways: the scratch database, a distinctive application_name
//     (PGAPPNAME on the app process), and the harness's own exemption.
//
// Two load modes:
//   hold-expiry  — Phase 5's hold-expiry-race.k6.js unchanged: every seeded
//                  Hold is already past its TTL when 5 confirms and 5 fresh
//                  POST /holds per seat race the reaper. Claim: a confirm
//                  never succeeds post-expiry, no seat ends up stuck `held`.
//   hold-confirm — hold-confirm-race.k6.js: confirms against still-live Holds
//                  (long TTL) under the Fault, then every Confirm is retried
//                  after the Fault clears (the Ambiguous-outcome recovery).
//                  Claim: each Hold ends with exactly one Booking.
//
// Exit status: nonzero iff an Oracle failed (a Correctness violation) —
// inverted by --expect-violations for the negative controls (ADR-0023).
//
// Usage: tsx load-harness/chaos/runHolds.ts [--mode hold-expiry|hold-confirm]
//   [--concurrency N] [--fault backend-kill|none] [--survive-uncaught]
//   [--kill-interval-ms 40] [--kill-fraction 0.5] [--post-load-fault-ms 3000]
//   [--attempts-per-hold 3] [--hold-ttl-seconds N] [--reaper-interval-ms 1000] [--reaper-stall-seats K]
//   [--sabotage late-confirm|duplicate-confirm] [--expect-violations]
//   [--label name] [--app-port 3300]
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import "dotenv/config";
import { confirmIdempotencyKey } from "../../src/strategies/pessimisticConfirm.js";
import { startBackendKiller, type BackendKillStats } from "./faults.js";
import {
  checkLiveConfirmYieldsOneBooking,
  checkNoConfirmAfterExpiry,
  confirmIntents,
  type HoldRecord,
} from "./holdOracles.js";
import { runOracles, snapshotBookingsByKey, type OracleResult } from "./oracles.js";
import {
  AppUnderTest,
  deriveRobustnessObservations,
  errorSignatures,
  printOracles,
  runK6,
  sleep,
  type K6Outcome,
} from "./run.js";
import { createScratchDb, IDEMPOTENCY_UNIQUE_CONSTRAINTS, type ScratchDb } from "./scratchDb.js";

// Not the harness's own name (racetoseat-chaos): the Fault driver exempts
// that one and, with onlyApplicationName set, kills ONLY this one.
const APP_APPLICATION_NAME = "racetoseat-c3-app";
// k6's hold-expiry-race.k6.js fires 10 VUs per seat all at once; macOS's
// kern.ipc.somaxconn=128 resets connections beyond ~130 simultaneous even with
// no Fault (C1's finding), so the defaults stay under that.
const DEFAULT_CONCURRENCY = { "hold-expiry": 12, "hold-confirm": 40 } as const;
const DEFAULT_TTL_SECONDS = { "hold-expiry": 8, "hold-confirm": 120 } as const;

type Mode = "hold-expiry" | "hold-confirm";
type Sabotage = "none" | "late-confirm" | "duplicate-confirm";

interface Args {
  mode: Mode;
  concurrency: number;
  fault: "backend-kill" | "none";
  surviveUncaught: boolean;
  killIntervalMs: number;
  killFraction: number;
  postLoadFaultMs: number;
  // hold-confirm only: concurrent Confirm attempts per Hold. With >1 a killed
  // attempt is usually covered by a sibling; 1 makes every kill a Hold that
  // can only be completed by the post-Fault retry.
  attemptsPerHold: number;
  holdTtlSeconds: number;
  reaperIntervalMs: number;
  // hold-expiry only: K extra "bait" seats whose rows the harness keeps
  // row-locked across their Holds' expiry, so the reaper's sweep blocks on
  // them mid-statement and the Fault (which kills in-transaction backends)
  // reliably catches the reaper in flight. A plain random kill almost never
  // does — a sweep lasts microseconds (observed: 0 killed sweeps in the
  // first scaffolded runs).
  reaperStallSeats: number;
  sabotage: Sabotage;
  expectViolations: boolean;
  label: string;
  appPort: number;
}

function parseArgs(argv: string[]): Args {
  const oneOf = <T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T => {
    if (!allowed.includes(value as T)) throw new Error(`${flag} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
    return value as T;
  };
  const posInt = (flag: string, value: string | undefined, min = 1): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}, got ${JSON.stringify(value)}`);
    return n;
  };
  const args: Partial<Args> & Pick<Args, "mode"> = { mode: "hold-expiry" };
  const raw = {
    fault: "backend-kill" as Args["fault"],
    surviveUncaught: false,
    killIntervalMs: 40,
    killFraction: 0.5,
    postLoadFaultMs: undefined as number | undefined,
    reaperIntervalMs: 1000,
    reaperStallSeats: 0,
    sabotage: "none" as Sabotage,
    expectViolations: false,
    label: "",
    appPort: 3300,
    concurrency: undefined as number | undefined,
    attemptsPerHold: 3,
    holdTtlSeconds: undefined as number | undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--mode") args.mode = oneOf(flag, argv[++i], ["hold-expiry", "hold-confirm"]);
    else if (flag === "--concurrency") raw.concurrency = posInt(flag, argv[++i]);
    else if (flag === "--fault") raw.fault = oneOf(flag, argv[++i], ["backend-kill", "none"]);
    else if (flag === "--survive-uncaught") raw.surviveUncaught = true;
    else if (flag === "--kill-interval-ms") raw.killIntervalMs = posInt(flag, argv[++i]);
    else if (flag === "--kill-fraction") {
      const f = Number(argv[++i]);
      if (!(f > 0 && f <= 1)) throw new Error(`--kill-fraction must be in (0, 1], got ${f}`);
      raw.killFraction = f;
    } else if (flag === "--post-load-fault-ms") raw.postLoadFaultMs = posInt(flag, argv[++i], 0);
    else if (flag === "--attempts-per-hold") raw.attemptsPerHold = posInt(flag, argv[++i]);
    else if (flag === "--hold-ttl-seconds") raw.holdTtlSeconds = posInt(flag, argv[++i]);
    else if (flag === "--reaper-interval-ms") raw.reaperIntervalMs = posInt(flag, argv[++i]);
    else if (flag === "--reaper-stall-seats") raw.reaperStallSeats = posInt(flag, argv[++i], 0);
    else if (flag === "--sabotage") raw.sabotage = oneOf(flag, argv[++i], ["none", "late-confirm", "duplicate-confirm"]);
    else if (flag === "--expect-violations") raw.expectViolations = true;
    else if (flag === "--label") raw.label = String(argv[++i]);
    else if (flag === "--app-port") raw.appPort = posInt(flag, argv[++i]);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  const port = raw.appPort;
  if (port < 3300 || port > 3399) {
    // Sibling chaos sessions own other port blocks on this machine.
    throw new Error(`--app-port must be within 3300-3399 for this harness, got ${port}`);
  }
  return {
    mode: args.mode,
    concurrency: raw.concurrency ?? DEFAULT_CONCURRENCY[args.mode],
    fault: raw.fault,
    surviveUncaught: raw.surviveUncaught,
    killIntervalMs: raw.killIntervalMs,
    killFraction: raw.killFraction,
    // The reaper only has something to sweep in hold-expiry; hold-confirm's
    // Holds don't expire during the run.
    postLoadFaultMs: raw.postLoadFaultMs ?? (args.mode === "hold-expiry" ? 3000 : 0),
    attemptsPerHold: raw.attemptsPerHold,
    holdTtlSeconds: raw.holdTtlSeconds ?? DEFAULT_TTL_SECONDS[args.mode],
    reaperIntervalMs: raw.reaperIntervalMs,
    reaperStallSeats: raw.reaperStallSeats,
    sabotage: raw.sabotage,
    expectViolations: raw.expectViolations,
    label: raw.label,
    appPort: port,
  };
}

// --- seeding (real API) -------------------------------------------------------

// Same budget as hold-expiry-race.k6.js's FRESH_HOLD_MAX_ATTEMPTS x
// FRESH_HOLD_RETRY_SLEEP_SECONDS (see run.ts's FRESH_HOLD_RETRY_BUDGET_MS):
// the TTL must outlast it or a winning fresh hold can expire and be re-won
// before k6 ends.
const FRESH_HOLD_RETRY_BUDGET_MS = 10 * 0.3 * 1000;

async function seedEventAndSeats(db: Pool, n: number): Promise<{ eventId: string; seatIds: string[] }> {
  const eventId = (await db.query<{ id: string }>("INSERT INTO events (name) VALUES ('Chaos: Holds under Fault') RETURNING id")).rows[0]!.id;
  const seats = await db.query<{ id: string }>(
    "INSERT INTO seats (event_id, label) SELECT $1, 'H' || gs FROM generate_series(1, $2) gs RETURNING id",
    [eventId, n],
  );
  return { eventId, seatIds: seats.rows.map((r) => r.id) };
}

// Holds every seat through the real POST /holds (no Fault active yet, so any
// non-201 is a harness/setup failure and aborts the run), then reads the
// resulting Holds back from the database — the ledger is what Postgres
// stored, not what a response said.
async function seedHoldsViaApi(
  appPort: number,
  db: Pool,
  eventId: string,
  seatIds: string[],
  runId: string,
): Promise<HoldRecord[]> {
  let next = 0;
  const worker = async () => {
    while (next < seatIds.length) {
      const i = next++;
      const res = await fetch(`http://localhost:${appPort}/holds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seat_ids: [seatIds[i]], user_id: `chaos-hold-user-${i + 1}`, idempotency_key: `${runId}-seed-${i + 1}` }),
      });
      const text = await res.text();
      if (res.status !== 201) throw new Error(`Seeding hold ${i + 1} via POST /holds failed: HTTP ${res.status} ${text}`);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));

  const rows = await db.query<{ hold_id: string; seat_id: string; booked_by: string; held_until: string; held_until_ms: string }>(
    `SELECT hs.hold_id, hs.seat_id, s.booked_by, s.held_until::text AS held_until,
            (extract(epoch from s.held_until) * 1000)::bigint AS held_until_ms
     FROM hold_seats hs JOIN seats s ON s.id = hs.seat_id
     WHERE s.event_id = $1 ORDER BY s.label`,
    [eventId],
  );
  if (rows.rows.length !== seatIds.length) {
    throw new Error(`Seeded ${seatIds.length} holds but the database shows ${rows.rows.length} hold_seats rows`);
  }
  // One Hold per seat here, so the rows are the holds.
  return rows.rows.map((r) => ({
    holdId: r.hold_id,
    seatIds: [r.seat_id],
    userId: r.booked_by,
    heldUntilText: r.held_until,
    heldUntilMs: Number(r.held_until_ms),
  }));
}

// --- recovery replay ----------------------------------------------------------

interface ConfirmReplay {
  tally: Record<string, number>;
  // Holds whose retried Confirm the app definitively answered (any HTTP
  // status except a 5xx), with the time the answer arrived.
  answered: Map<string, { status: number; atMs: number }>;
  unanswered: string[];
}

// The Ambiguous-outcome recovery: a client that never learned how its Confirm
// ended simply re-sends it. 5xx / connection errors are retried a few times
// (a client would); only a definitive answer counts as "answered".
async function replayConfirms(appPort: number, holds: HoldRecord[]): Promise<ConfirmReplay> {
  const tally: Record<string, number> = {};
  const answered = new Map<string, { status: number; atMs: number }>();
  const unanswered: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < holds.length) {
      const hold = holds[next++]!;
      let done = false;
      for (let attempt = 0; attempt < 6 && !done; attempt += 1) {
        try {
          const res = await fetch(`http://localhost:${appPort}/holds/${hold.holdId}/confirm`, { method: "POST" });
          await res.arrayBuffer();
          tally[res.status] = (tally[res.status] ?? 0) + 1;
          if (res.status < 500) {
            answered.set(hold.holdId, { status: res.status, atMs: Date.now() });
            done = true;
          }
        } catch {
          tally["network-error"] = (tally["network-error"] ?? 0) + 1;
        }
        if (!done) await sleep(250);
      }
      if (!done) unanswered.push(hold.holdId);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  return { tally, answered, unanswered };
}

// --- ground truth for the report ---------------------------------------------

async function seatStatusTally(db: Pool, eventId: string): Promise<Record<string, number>> {
  const res = await db.query<{ status: string; n: string }>(
    "SELECT status, count(*) AS n FROM seats WHERE event_id = $1 GROUP BY status",
    [eventId],
  );
  return Object.fromEntries(res.rows.map((r) => [r.status, Number(r.n)]));
}

async function applicationNamesSeen(db: Pool): Promise<Record<string, number>> {
  const res = await db.query<{ application_name: string; n: string }>(
    `SELECT application_name, count(*) AS n FROM pg_stat_activity
     WHERE datname = current_database() AND backend_type = 'client backend' GROUP BY application_name`,
  );
  return Object.fromEntries(res.rows.map((r) => [r.application_name || "(none)", Number(r.n)]));
}

function countLogLines(output: string[], prefix: string): number {
  return output.filter((line) => line.trim().startsWith(prefix)).length;
}

// --- sabotage (pipeline negative controls, ADR-0023) --------------------------

// The only way to make the *pessimistic* production code violate a Hold
// guarantee would be to weaken it, which this project forbids. These
// controls therefore corrupt the scratch database directly, after the load,
// the way the unit controls do — proving the pipeline (ledger → Oracle →
// report → exit status) goes red end to end, not just the Oracle's SQL.
async function applySabotage(db: Pool, kind: Sabotage, holds: HoldRecord[]): Promise<string | undefined> {
  if (kind === "none") return undefined;
  const hold = holds[0]!;
  const key = confirmIdempotencyKey(hold.holdId);
  if (kind === "late-confirm") {
    // A Booking appears for an already-expired Hold (as if confirm's expiry
    // check had been skipped), consistent in every other respect: seat
    // claimed and marked booked, so only the lifecycle Oracle can see it.
    await db.query("UPDATE seats SET status = 'booked', booked_by = $1, held_until = NULL WHERE id = ANY($2)", [hold.userId, hold.seatIds]);
    const b = await db.query<{ id: string }>("INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id", [hold.userId, key]);
    for (const seatId of hold.seatIds) await db.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [b.rows[0]!.id, seatId]);
    return `inserted a post-expiry booking for hold ${hold.holdId}`;
  }
  // duplicate-confirm: a second Booking row under the same confirm key (needs
  // the scratch database's idempotency UNIQUE dropped).
  await db.query("INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2)", [hold.userId, key]);
  return `inserted a second booking under ${key}`;
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is required (direct Postgres, e.g. localhost:5433)");
  if (args.mode === "hold-expiry" && FRESH_HOLD_RETRY_BUDGET_MS >= args.holdTtlSeconds * 1000) {
    throw new Error(`--hold-ttl-seconds ${args.holdTtlSeconds} must exceed the fresh-hold retry budget (${FRESH_HOLD_RETRY_BUDGET_MS}ms)`);
  }
  if (args.reaperStallSeats > 0 && args.mode !== "hold-expiry") throw new Error("--reaper-stall-seats needs --mode hold-expiry");
  if (args.sabotage === "late-confirm" && args.mode !== "hold-expiry") throw new Error("--sabotage late-confirm needs --mode hold-expiry");
  if (args.sabotage === "duplicate-confirm" && args.mode !== "hold-confirm") throw new Error("--sabotage duplicate-confirm needs --mode hold-confirm");

  // Full real schema; only the duplicate-confirm control weakens it (drops the
  // idempotency UNIQUEs so a second row can exist at all).
  const scratch: ScratchDb = await createScratchDb(
    baseUrl,
    args.sabotage === "duplicate-confirm" ? IDEMPOTENCY_UNIQUE_CONSTRAINTS : [],
  );
  const db = scratch.pool;
  let app: AppUnderTest | undefined;
  try {
    const dbName = (await db.query<{ n: string }>("SELECT current_database() AS n")).rows[0]!.n;
    const sharedName = new URL(baseUrl).pathname.slice(1);
    if (dbName === sharedName || !dbName.startsWith("racetoseat_chaos_")) {
      throw new Error(`Refusing to run: expected a scratch database, connected to "${dbName}"`);
    }
    console.log(`Scratch database ${dbName} (full real schema${args.sabotage === "duplicate-confirm" ? " minus idempotency UNIQUEs" : ""}).`);

    const { eventId, seatIds: allSeatIds } = await seedEventAndSeats(db, args.concurrency + args.reaperStallSeats);
    const seatIds = allSeatIds.slice(0, args.concurrency);
    const baitSeatIds = allSeatIds.slice(args.concurrency);
    const runId = randomUUID();

    const appEnv: Record<string, string> = {
      DATABASE_URL: scratch.connectionString,
      BOOKING_STRATEGY: "pessimistic",
      HOLD_TTL_SECONDS: String(args.holdTtlSeconds),
      REAPER_INTERVAL_MS: String(args.reaperIntervalMs),
      PGAPPNAME: APP_APPLICATION_NAME,
      // Good neighbour on the shared Postgres (max_connections=600 is also
      // used by sibling sessions); the app's own default is 500.
      PG_POOL_MAX: "100",
    };
    if (args.surviveUncaught) {
      const preload = fileURLToPath(new URL("./survive-uncaught.mjs", import.meta.url));
      appEnv.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import ${preload}`.trim();
    }
    app = new AppUnderTest(appEnv, args.appPort);
    await app.start();
    console.log(`App started (pessimistic, :${args.appPort}, TTL=${args.holdTtlSeconds}s, reaper every ${args.reaperIntervalMs}ms).`);

    const allHolds = await seedHoldsViaApi(args.appPort, db, eventId, allSeatIds, runId);
    const baitSet = new Set(baitSeatIds);
    const holds = allHolds.filter((h) => !baitSet.has(h.seatIds[0]!));
    const seededHoldIds = holds.map((h) => h.holdId);
    // Bait seats: row-locked by a harness connection (exempt from the Fault)
    // from now until the Fault window ends. Not part of the k6 load or the
    // confirm ledger, but in the same event, so the Oracles still judge them.
    let baitLock: PoolClient | undefined;
    if (baitSeatIds.length > 0) {
      baitLock = await db.connect();
      await baitLock.query("BEGIN");
      await baitLock.query("SELECT id FROM seats WHERE id = ANY($1) FOR UPDATE", [baitSeatIds]);
    }
    const appNames = await applicationNamesSeen(db);
    console.log(`Seeded ${holds.length} holds via POST /holds; backends by application_name: ${JSON.stringify(appNames)}`);

    if (args.mode === "hold-expiry") {
      const lastExpiry = Math.max(...holds.map((h) => h.heldUntilMs));
      const wait = lastExpiry - Date.now() + 50;
      console.log(`Waiting ${Math.max(0, wait)}ms for every seeded hold to pass its TTL...`);
      if (wait > 0) await sleep(wait);
    }

    const k6Script = fileURLToPath(new URL(args.mode === "hold-expiry" ? "../hold-expiry-race.k6.js" : "../hold-confirm-race.k6.js", import.meta.url));
    const k6Env: Record<string, string> =
      args.mode === "hold-expiry"
        ? { RUN_ID: runId, HOLD_IDS: JSON.stringify(seededHoldIds), SEAT_IDS: JSON.stringify(holds.map((h) => h.seatIds[0]!)) }
        : { RUN_ID: runId, HOLD_IDS: JSON.stringify(seededHoldIds), ATTEMPTS_PER_HOLD: String(args.attemptsPerHold) };

    const ranAt = new Date();
    console.log(`Firing ${args.mode} load with fault=${args.fault}...`);
    const killer =
      args.fault === "backend-kill"
        ? startBackendKiller(db, {
            intervalMs: args.killIntervalMs,
            fraction: args.killFraction,
            scope: "in-transaction",
            onlyApplicationName: APP_APPLICATION_NAME,
          })
        : undefined;
    let k6: K6Outcome;
    let killStats: BackendKillStats | undefined;
    try {
      k6 = await runK6(k6Script, k6Env, args.appPort);
      // Keep the Fault on after the load drains so the reaper's own sweeps
      // (which run on a timer, not per request) are exposed to it too.
      if (killer && args.postLoadFaultMs > 0) await sleep(args.postLoadFaultMs);
    } finally {
      killStats = await killer?.stop();
      if (baitLock) {
        await baitLock.query("ROLLBACK").catch(() => undefined);
        baitLock.release();
      }
    }
    console.log(`Load finished in ${k6.durationMs}ms; k6 statuses: ${JSON.stringify(k6.statusTally)}.`);
    if (killStats) console.log(`Fault: ${killStats.terminated} backend(s) terminated over ${killStats.sweeps} sweeps ${JSON.stringify(killStats.terminatedByState)}.`);

    // Fault cleared. Let it settle, make sure the app (and with it the
    // reaper) is back, then give the reaper time before judging liveness: in
    // hold-expiry every Hold — including any fresh one a racing client won
    // late in the run — must pass its TTL and then see >=3 reaper ticks.
    await sleep(1500);
    await app.ensureUp();
    const healedAtMs = Date.now();
    const statusAtHeal = await seatStatusTally(db, eventId);
    if (args.mode === "hold-expiry") {
      const latest = await db.query<{ ms: string | null }>(
        "SELECT (extract(epoch from max(held_until)) * 1000)::bigint AS ms FROM seats WHERE event_id = $1 AND status = 'held'",
        [eventId],
      );
      const lastExpiry = latest.rows[0]!.ms === null ? 0 : Number(latest.rows[0]!.ms);
      // >= 3 reaper ticks after both the last expiry and the moment the Fault
      // and its locks were gone.
      // (Capped so the reaper-off negative control, whose interval is an
      // hour, judges after a few seconds instead of sleeping for hours.)
      const wait = Math.max(lastExpiry, healedAtMs) + 3 * Math.min(args.reaperIntervalMs, 5000) + 500 - Date.now();
      console.log(`Healed (seats: ${JSON.stringify(statusAtHeal)}). Waiting ${Math.max(0, wait)}ms for the reaper to clear expired holds...`);
      if (wait > 0) await sleep(wait);
    }

    const ledger = confirmIntents(holds);
    const keys = ledger.map((e) => e.idempotencyKey);
    const before = await snapshotBookingsByKey(db, keys);
    console.log("Retrying Confirm on every Hold...");
    const replay = await replayConfirms(args.appPort, holds);
    console.log(`Confirm retry statuses: ${JSON.stringify(replay.tally)}${replay.unanswered.length ? `, ${replay.unanswered.length} hold(s) never answered` : ""}.`);
    await sleep(500);

    const sabotageNote = await applySabotage(db, args.sabotage, holds);
    if (sabotageNote) console.log(`SABOTAGE (negative control): ${sabotageNote}.`);

    // A Hold counts toward "exactly one Booking" only if it was provably live
    // when the app answered its retried Confirm.
    const nowMs = Date.now();
    const mustHaveBooking = holds
      .filter((h) => {
        const a = replay.answered.get(h.holdId);
        return a !== undefined && a.atMs < h.heldUntilMs && nowMs < h.heldUntilMs;
      })
      .map((h) => h.holdId);

    const base = await runOracles(db, {
      scope: { eventId },
      ledger,
      before,
      liveness: { expiredHoldGraceSeconds: 2 },
    });
    const extensions: OracleResult[] = [
      await checkNoConfirmAfterExpiry(db, holds),
      await checkLiveConfirmYieldsOneBooking(db, holds, mustHaveBooking),
    ];
    const oracles = [...base, ...extensions];
    printOracles(oracles);

    const finalSeats = await seatStatusTally(db, eventId);
    const confirmBookings = Number(
      (await db.query<{ n: string }>("SELECT count(*) AS n FROM bookings WHERE idempotency_key = ANY($1)", [keys])).rows[0]!.n,
    );
    const leftoverHolds = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM holds")).rows[0]!.n);
    console.log(`Final: seats ${JSON.stringify(finalSeats)}; ${confirmBookings} confirm-key booking(s); ${leftoverHolds} hold row(s) remaining.`);

    const correctnessViolation = oracles.some((o) => !o.passed);
    const robustness = deriveRobustnessObservations(app, k6);
    const reaperSweepFailures = countLogLines(app.output, "Reaper sweep failed");
    if (reaperSweepFailures > 0) {
      robustness.push({ id: "reaper-sweep-failed", detail: `${reaperSweepFailures} reaper sweep(s) failed and were logged (the reaper survives a failed sweep — server.ts/reaper.ts catch it)` });
    }
    if (replay.unanswered.length > 0) {
      robustness.push({ id: "confirm-retry-unanswered", detail: `${replay.unanswered.length} hold(s) never got a non-5xx answer to a retried Confirm after the Fault cleared (6 attempts each)` });
    }
    if (args.surviveUncaught) {
      const swallowed = countLogLines(app.output, "[chaos preload] swallowed uncaughtException");
      robustness.push({ id: "uncaught-exceptions-swallowed-by-scaffold", detail: `${swallowed} uncaught exception(s) swallowed by --survive-uncaught (each would have crashed the unmodified app)` });
    }
    for (const r of robustness) console.log(`  Robustness observation [${r.id}]: ${r.detail}`);

    const label =
      args.label ||
      `c3-${args.mode}-${args.fault}${args.surviveUncaught ? "-survive" : "-unmodified"}${args.sabotage !== "none" ? `-sabotage-${args.sabotage}` : ""}`;
    const stamp = ranAt.toISOString().replace(/[:.]/g, "-");
    const report = {
      label,
      ranAt: ranAt.toISOString(),
      args,
      scratchDatabase: dbName,
      applicationNamesSeen: appNames,
      eventId,
      holdsSeeded: holds.length,
      reaperStallSeats: baitSeatIds.length,
      fault: { kind: args.fault, scope: "in-transaction", intervalMs: args.killIntervalMs, fraction: args.killFraction, postLoadFaultMs: args.postLoadFaultMs, onlyApplicationName: APP_APPLICATION_NAME, stats: killStats },
      k6: { statusTally: k6.statusTally, transportErrors: k6.transportErrors, durationMs: k6.durationMs, maxRequestMs: Math.round(k6.maxRequestMs) },
      app: { exits: app.exits, restarts: app.restarts, reaperSweepFailures, errorSignatures: errorSignatures(app.output) },
      confirmRetry: { tally: replay.tally, bookedBeforeRetry: Object.keys(before).length, createdByRetry: confirmBookings - Object.keys(before).length, unanswered: replay.unanswered.length, heldLiveAtAnswer: mustHaveBooking.length },
      seatStatusAtHeal: statusAtHeal,
      finalState: { seats: finalSeats, confirmKeyBookings: confirmBookings, holdRowsRemaining: leftoverHolds },
      sabotage: sabotageNote ?? null,
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
      console.log("\nAll Oracles passed (4 base + 2 hold extensions).");
    }
  } finally {
    await app?.stop();
    await scratch.drop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
