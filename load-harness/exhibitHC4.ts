// Exhibit H, section N: C4, a Postgres restart under load (issue #51, ADR-0032).
//
// Kept out of exhibitH.ts (already ~2,000 lines) and fed from its own
// directory, docs/evidence/chaos/c4-restart/: those reports are not the shape
// of the other chaos reports (they carry a container, a server-side Fault
// timeline and a durability Oracle) and must not be classified into any of
// their groups. Every number below is recomputed from those JSON files.
import { readdir, readFile } from "node:fs/promises";

export interface C4Oracle {
  oracle: number;
  name: string;
  passed: boolean;
  violations: { kind: string; detail?: string }[];
}

export interface C4Report {
  label: string;
  ranAt: string;
  args: {
    variant: "restart" | "stop" | "kill" | "none";
    load: "spread" | "hammer" | "holds";
    profile: "safe" | "unsafe";
    seats: number;
    workers: number;
    downMs: number;
    holdTtlSeconds: number;
    reaperIntervalMs: number;
    expectViolations: boolean;
  };
  container: { settings: { synchronous_commit: string; fsync: string; wal_writer_delay: string; stopSignal: string } };
  requestsIssued: number;
  seats: number;
  acknowledged: { bookings: number; holds: number; confirms: number; atFault: number };
  fault: { unreachableMs: number | null; commandStartedAtMs: number; commandReturnedAtMs: number; heldDownMs: number } | null;
  finals: Record<string, number>;
  abandoned: number;
  attempts: number;
  windows: { before: Record<string, number>; during: Record<string, number>; after: Record<string, number> };
  recovery: {
    writeOutageMs: number | null;
    appLagAfterDbBackMs: number | null;
    firstFailureAfterFaultMs: number | null;
  };
  slowestAttemptMs: number;
  loadFinishedAtMs: number;
  drain: { drainedAfterMs: number | null; timedOut: boolean };
  reaper?: {
    atRecovery?: { expiredPendingAtRecovery: number; clearedAfterMs: number | null };
    caughtUpMs: number | null;
    stillHeld: number | null;
    sweepFailures: number;
  };
  app: { exits: unknown[]; restarts: number; errorSignatures: Record<string, number>; reaperSweepFailures: number };
  replay: { tally: Record<string, number>; networkErrors: number };
  oracles: C4Oracle[];
  correctnessViolation: boolean;
  robustnessObservations: { id: string; detail: string }[];
}

export interface LoadedC4Report {
  file: string;
  report: C4Report;
}

function isC4Report(value: unknown): value is C4Report {
  const v = value as Partial<C4Report> | null;
  return !!v && typeof v.label === "string" && typeof v.args?.variant === "string" && Array.isArray(v.oracles) && typeof v.container === "object" && typeof v.windows === "object";
}

export async function loadC4Reports(dir: URL): Promise<LoadedC4Report[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((e) => e.endsWith(".json") && !e.startsWith(".")).sort();
  } catch {
    return [];
  }
  const out: LoadedC4Report[] = [];
  for (const file of entries) {
    const parsed: unknown = JSON.parse(await readFile(new URL(file, dir), "utf8"));
    if (isC4Report(parsed)) out.push({ file, report: parsed });
  }
  return out;
}

// ---------------------------------------------------------------------------

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const fmtInt = (n: number): string => n.toLocaleString("en-US");
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const rng = (xs: (number | null | undefined)[]): string => {
  const v = xs.filter((x): x is number => typeof x === "number");
  if (v.length === 0) return "—";
  return `${Math.round(median(v))} (${Math.round(Math.min(...v))}–${Math.round(Math.max(...v))})`;
};
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function mdTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

const oracleOk = (r: C4Report, n: number): boolean => r.oracles.find((o) => o.oracle === n)?.passed ?? false;
const clean14 = (r: C4Report): boolean => [1, 2, 3, 4].every((n) => oracleOk(r, n));
const lostCount = (r: C4Report): number => (r.oracles.find((o) => o.oracle === 5)?.violations ?? []).filter((v) => /-lost$/.test(v.kind)).length;
const tallyOf = (t: Record<string, number>, status: string): number => t[status] ?? 0;
const noneCount = (t: Record<string, number>): number => sum(Object.entries(t).filter(([k]) => k.startsWith("none:")).map(([, n]) => n));
const ackedOf = (r: C4Report): number => (r.args.load === "holds" ? r.acknowledged.holds + r.acknowledged.confirms : r.acknowledged.bookings);

const LOAD_NAME: Record<string, string> = {
  spread: "`spread` (4,000 distinct seats, zero contention)",
  hammer: "`hammer` (250 hot seats, 30 clients racing each in lockstep)",
  holds: "`holds` (1,500 seats: `POST /holds`, half then confirmed)",
};

function cellKey(r: C4Report): string {
  const tag = r.args.load === "holds" && r.args.holdTtlSeconds === 4 ? "-short" : r.args.downMs === 15000 ? "-down15s" : "";
  return `${r.args.load}${tag}/${r.args.variant}`;
}

function cellName(r: C4Report): string {
  const how = r.args.variant === "restart" ? "`docker restart`" : r.args.variant === "stop" ? `\`docker stop\` + ${secs(r.args.downMs)} down` : r.args.variant === "kill" ? `\`docker kill\` (SIGKILL) + ${secs(r.args.downMs)} down` : "no Fault";
  const extra = r.args.load === "holds" && r.args.holdTtlSeconds === 4 ? ", TTL 4 s" : "";
  return `${r.args.load}${extra} — ${how}`;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

const ORDER = ["spread", "hammer", "holds", "holds-short", "spread-down15s", "holds-down15s"];
const VARIANT_ORDER = ["restart", "stop", "kill", "none"];
function sortedCells(rs: C4Report[]): [string, C4Report[]][] {
  return [...groupBy(rs, cellKey).entries()].sort(([a], [b]) => {
    const [la, va] = a.split("/");
    const [lb, vb] = b.split("/");
    return ORDER.indexOf(la!) - ORDER.indexOf(lb!) || VARIANT_ORDER.indexOf(va!) - VARIANT_ORDER.indexOf(vb!);
  });
}

function renderMain(rs: C4Report[]): string {
  const rows = sortedCells(rs).map(([, g]) => {
    const f = g[0]!;
    return [
      cellName(f),
      String(g.length),
      fmtInt(sum(g.map(ackedOf))),
      `${g.filter(clean14).length}/${g.length}`,
      `${g.filter((r) => oracleOk(r, 5)).length}/${g.length}`,
      String(sum(g.map(lostCount))),
      rng(g.map((r) => r.fault?.unreachableMs)),
      rng(g.map((r) => r.recovery.writeOutageMs)),
      rng(g.map((r) => r.recovery.appLagAfterDbBackMs)),
      `${sum(g.map((r) => tallyOf(r.windows.during, "502")))} / ${sum(g.map((r) => tallyOf(r.windows.during, "504")))} / ${sum(g.map((r) => noneCount(r.windows.during)))}`,
      String(Math.max(...g.map((r) => r.slowestAttemptMs))),
      `${sum(g.map((r) => r.app.exits.length))} / ${sum(g.map((r) => r.abandoned))}`,
    ];
  });
  return mdTable(
    ["Cell (stock Postgres)", "Runs", "201s acknowledged", "Oracles 1–4 clean", "Oracle 5 clean", "Acknowledged work lost", "Server unreachable, ms (median, range)", "Client write outage, ms", "App lag after server back, ms", "Attempts during outage: 502 / 504 / no answer", "Slowest attempt, ms", "App crashes / abandoned requests"],
    rows,
  );
}

function renderHolds(rs: C4Report[]): string {
  const holds = rs.filter((r) => r.args.load === "holds" && r.args.variant !== "none");
  if (holds.length === 0) return "_No hold runs recorded._";
  const rows = sortedCells(holds).map(([, g]) => [
    cellName(g[0]!),
    String(g.length),
    fmtInt(sum(g.map((r) => r.acknowledged.holds))),
    fmtInt(sum(g.map((r) => r.acknowledged.confirms))),
    fmtInt(sum(g.map((r) => r.reaper?.atRecovery?.expiredPendingAtRecovery ?? 0))),
    rng(g.map((r) => ((r.reaper?.atRecovery?.expiredPendingAtRecovery ?? 0) > 0 ? (r.reaper?.atRecovery?.clearedAfterMs ?? null) : null))),
    String(sum(g.map((r) => r.reaper?.sweepFailures ?? 0))),
    `${g.filter((r) => r.reaper?.stillHeld === 0).length}/${g.length}`,
    `${g.filter((r) => oracleOk(r, 4)).length}/${g.length}`,
  ]);
  return mdTable(
    ["Cell", "Runs", "Holds acknowledged", "Confirms acknowledged", "Holds already expired when the server came back", "Reaper cleared that backlog after, ms", "Reaper sweeps that failed and were survived", "Every seat `available` at the end", "Oracle 4 clean"],
    rows,
  );
}

function renderControls(controls: C4Report[], refs: C4Report[]): string {
  const rows = [...sortedCells(controls), ...sortedCells(refs)].map(([, g]) => {
    const f = g[0]!;
    const isControl = f.args.expectViolations;
    return [
      isControl ? "negative control" : "reference",
      `${f.args.load} — ${f.args.variant === "kill" ? "`docker kill`" : "`docker restart`"}`,
      `\`synchronous_commit=${f.container.settings.synchronous_commit}\`, \`wal_writer_delay=${f.container.settings.wal_writer_delay} ms\`, \`fsync=${f.container.settings.fsync}\``,
      String(g.length),
      fmtInt(sum(g.map(ackedOf))),
      `${g.filter((r) => !oracleOk(r, 5)).length}/${g.length}`,
      fmtInt(sum(g.map(lostCount))),
      `${g.filter(clean14).length}/${g.length}`,
    ];
  });
  return mdTable(["Role", "Cell", "Server configuration", "Runs", "201s acknowledged", "Runs Oracle 5 flagged", "Acknowledged work lost", "Runs Oracles 1–4 all clean"], rows);
}

function renderBaseline(rs: C4Report[]): string {
  if (rs.length === 0) return "_No baseline runs recorded._";
  const rows = [...groupBy(rs, (r) => r.args.load).entries()].map(([load, g]) => [
    load,
    String(g.length),
    fmtInt(sum(g.map(ackedOf))),
    `${g.filter((r) => clean14(r) && oracleOk(r, 5)).length}/${g.length}`,
    rng(g.map((r) => r.loadFinishedAtMs)),
    String(Math.max(...g.map((r) => r.slowestAttemptMs))),
    String(sum(g.map((r) => sum(Object.entries(r.windows.before).filter(([s]) => s !== "201" && s !== "409").map(([, n]) => n))))),
  ]);
  return mdTable(["Load", "Runs", "201s acknowledged", "All five Oracles clean", "Load duration, ms", "Slowest attempt, ms", "Attempts that were neither 201 nor 409"], rows);
}

export function renderC4Section(all: LoadedC4Report[]): string {
  const reports = all.map((x) => x.report);
  const measured = reports.filter((r) => !r.args.expectViolations && r.args.profile === "safe" && r.args.variant !== "none");
  const baseline = reports.filter((r) => r.args.variant === "none");
  const controls = reports.filter((r) => r.args.expectViolations);
  const refs = reports.filter((r) => !r.args.expectViolations && r.args.profile === "unsafe");
  const lostMeasured = sum(measured.map(lostCount));
  const violationsMeasured = measured.filter((r) => r.correctnessViolation);
  const unreachable = measured.map((r) => r.fault?.unreachableMs).filter((x): x is number => typeof x === "number");
  const flagged = controls.filter((r) => !oracleOk(r, 5));
  const controlsClean14 = controls.filter(clean14);

  return `Issue #51 (C4) is the one planned chaos scenario that took the database *server* away. Everything before it removed a connection, a link or the app; none of it could test what the formal model assumes about Postgres, that a \`COMMIT\` the client has been told about is still there afterwards (\`CommittedPersists\`, \`formal/CrashRecovery.tla\`; Exhibit G, "What this does not prove"). **${fmtInt(measured.length)} measured runs, ${fmtInt(sum(measured.map(ackedOf)))} acknowledged Bookings / Holds / Confirms: ${lostMeasured} lost, ${violationsMeasured.length} Correctness violations.** ${flagged.length} of ${controls.length} negative controls went red on Oracle 5 with ${fmtInt(sum(controls.map(lostCount)))} acknowledged commits missing, and in ${controlsClean14.length} of those ${controls.length} the other four Oracles stayed green on the same lost-commit state.

**How it was run** (ADR-0032; \`npm run chaos:restart\`, \`npm run chaos:restart:matrix\`; code in \`load-harness/chaos/restart*.ts\`, \`durabilityOracle.ts\`). Each run creates a Postgres container of its own (\`c4-pg-<hex>\`, \`postgres:17\`, a free loopback port; ownership of the container id, name and a run label is re-checked before every stop / kill / start / remove, and no other container, including the compose database, is ever addressed), applies \`db/schema.sql\`, seeds, issues \`CHECKPOINT\`, and starts the **unmodified** app (\`src/server.ts\`, \`pessimistic\`, no \`--survive-uncaught\`) against it. A sustained Node client (\`restartLoad.ts\`; not k6: the load has to outlast a restart and the Booking id of every \`201\` has to be recorded) applies the load; after 30 % of the operations have been acknowledged the Fault lands. Clients follow the retry contract of ADR-0025/0026: an attempt that gets no answer, a \`502\`, a \`504\` or another \`5xx\` is retried with the same Idempotency Key (up to 60 s), a \`409\` is a definitive loss. Three ways to take the server away, each repeated three times per load (more on the cells below that say so): \`docker restart\` (the image's stop signal is \`SIGINT\`, Postgres's *fast shutdown*: sessions terminated, in-flight transactions rolled back, shutdown checkpoint, immediate restart); \`docker stop\` then 3 s down then \`docker start\` (the same orderly shutdown, held down as long as the kill so the two shutdown modes compare at equal outage); \`docker kill\` (SIGKILL: no shutdown, no checkpoint) then 3 s down then \`docker start\`, so the server replays its WAL.

After the load has finished and the server is back, **Oracle 5 (durability of acknowledged work, \`durabilityOracle.ts\`) runs first, before the Idempotency-Key replay**: every Booking id a client was answered \`201\` for must exist, under the key and seats it was acknowledged for, with its seats \`booked\` for its user and no second Booking under the key; for Holds, an acknowledged Hold must still be live, have become a Booking, or be past its expiry, and an acknowledged Confirm's Booking must exist. Then every key is replayed and Oracles 1–4 run as in every other chaos run. Oracle 5 is the one place a chaos verdict leans on an HTTP answer, and only in one direction: a \`201\` is read as a promise the stored state is then asked to have kept (ADR-0032 argues why this does not break ADR-0022's rule).

### N1. The restart and the kill, stock Postgres

Every cell is 3 repeats unless the Runs column says otherwise. *Server unreachable* is the span between the harness's first failed and first successful probe of the server; *client write outage* is the time from the last \`201\` before the Fault to the first \`201\` after the server was back; *app lag* is how much of that was the app, from the first moment the server answered to the first \`201\` the app served. Attempts are individual HTTP tries (a retried request counts each time); "no answer" is a connection error or client timeout.

${renderMain(measured)}

${measured.length ? `Across all ${fmtInt(measured.length)} measured runs the server was unreachable for ${rng(unreachable)} ms (median, range); the slowest single attempt was ${fmtInt(Math.max(...measured.map((r) => r.slowestAttemptMs)))} ms, ${fmtInt(sum(measured.map((r) => r.abandoned)))} requests were abandoned without a definitive answer, and the app process exited ${sum(measured.map((r) => r.app.exits.length))} time(s).` : ""}

### N2. Holds: the reaper across the outage

Hold runs seed 1,500 seats through \`POST /holds\`, confirm about half, and let the rest expire; the reaper runs inside the app as in production (\`REAPER_INTERVAL_MS\` ${measured.find((r) => r.args.load === "holds")?.args.reaperIntervalMs ?? 1000} ms). The *TTL 4 s* cells make holds expire while the server is down, so the reaper has a backlog the moment it can reach the database again.

${renderHolds(measured)}

### N3. Negative controls and the reference (ADR-0023)

The weakening is in the *server's configuration*, never in \`src/\` (no test-only toggle in production code): \`synchronous_commit=off\`, \`wal_writer_delay=10000ms\` (the maximum), \`wal_writer_flush_after=1GB\`, \`checkpoint_timeout=1h\`, \`fsync=off\`. A commit is then acknowledged while its WAL record still sits in the server's memory, and nothing flushes it for up to 10 s, so a SIGKILL loses every acknowledged commit of that window. The harness checkpoints after seeding, so only the Bookings under test are at risk. The reference is the *same* weakened server restarted orderly: the shutdown checkpoint flushes everything, so nothing may be lost, which shows the control's red comes from the kill and not from the configuration alone.

${renderControls(controls, refs)}

### N4. No-Fault baselines

${renderBaseline(baseline)}

### N5. What this does and does not establish

- **A returned \`COMMIT\` survived a SIGKILL of the Postgres process in every measured run**, with default durability settings (\`synchronous_commit=on\`, \`fsync=on\`), for Bookings, Holds and Confirms. The formal model's assumption holds for the process-kill case, and Oracle 5 demonstrably can see the opposite (section N3). What was not tested: **a machine or kernel crash, or power loss.** \`docker kill\` ends the Postgres processes but the Linux VM's page cache, and with it every WAL write the server had handed to the OS, survives; \`fsync\` is therefore not on this path, which is also why \`fsync=off\` is not what loses commits in the control. Testing fsync honesty would need a way to drop the page cache of the volume, which this harness does not have.
- The control shows the *checker* is sound for a lost commit under a hard kill; it does not show that stock Postgres cannot lose one under a different Fault.
- All outages here are *fast-failing*: Docker's published port refuses connections the moment the container stops (\`ECONNREFUSED\`, every attempt answered within ~${Math.max(...measured.map((r) => r.slowestAttemptMs))} ms). A server that is gone but still accepting packets (a failover that black-holes the old address) looks like the partition Faults of C2 and R4, not like this; sections C and G cover that case.
- One app process, one connection pool, one scratch Postgres on one machine; the client count is 30 and the load a few hundred requests per second.
`;
}
