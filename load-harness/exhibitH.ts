// Exhibit H (issue #52, C5): Phase 6's chaos-testing evidence document.
//
// Everything numeric in the exhibit is recomputed from the per-run JSON
// reports under docs/evidence/chaos/ (written by load-harness/chaos/run.ts,
// matrix.ts and runHolds.ts) — never copied from the prose findings records
// (chaos-c1-tracer-findings.md, chaos-c2-fault-matrix.md,
// chaos-c3-holds-under-fault.md). `checkRecordClaims` goes one step further
// and re-derives each number those records quote, so a record that drifted
// from its own evidence shows up as a DIFF row in the exhibit instead of
// being repeated.
//
// Lives beside aggregate.ts (which wires it up as `--exhibit h`) rather than
// inside it only to keep that file from doubling in size; the pure functions
// here take already-loaded reports so tests can feed them synthetic ones.
//
// ADR-0022: evidence from unmodified production code and from
// `--survive-uncaught`-scaffolded runs is never merged. Every aggregate below
// is computed per variant, and the renderer keeps them in separate sections.
import { readdir, readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Report shape (only the fields this exhibit reads)

export interface OracleResultLike {
  oracle: number;
  name: string;
  passed: boolean;
  violations: { kind: string; detail?: string }[];
}

export interface ChaosArgs {
  strategy?: string;
  load?: string;
  mode?: string;
  fault: string;
  surviveUncaught?: boolean;
  expectViolations?: boolean;
  db?: string;
  concurrency?: number;
  killIntervalMs?: number;
  killFraction?: number;
  attemptsPerHold?: number;
  reaperStallSeats?: number;
  reaperIntervalMs?: number;
  holdTtlSeconds?: number;
  sabotage?: string;
  requestTimeoutMs?: number;
  partitionJitterMs?: number;
}

export interface ChaosReport {
  label: string;
  ranAt: string;
  args: ChaosArgs;
  oracles: OracleResultLike[];
  correctnessViolation: boolean;
  k6: {
    statusTally: Record<string, number>;
    clientTimeouts?: number;
    maxRequestMs: number;
    p95RequestMs?: number;
    p50RequestMs?: number;
  };
  app: {
    exits: unknown[];
    errorSignatures: Record<string, number>;
    reaperSweepFailures?: number;
  };
  fault?: { kind: string; stats?: { terminated: number } };
  networkFault?: {
    kind: string;
    latencyMs?: number;
    partitionDurationMs?: number;
    baseLatencyMs?: number;
    openTxWhenApplied?: number;
  };
  baseLatencyMs?: number;
  appKill?: { kills: number; restartMs: number[]; openTxAtKill: (number | undefined)[] };
  stall?: { maxOpenTxAgeMs: number; peakLockHolders: number };
  drain?: { drainedAfterMs: number | null; timedOut: boolean };
  ambiguity?: { committedUnacknowledged: number; requestsWithoutAnswer: number };
  replay?: { tally: Record<string, number>; networkErrors?: number };
  holdsSeeded?: number;
  confirmRetry?: { createdByRetry: number; tally: Record<string, number> };
  requestsIssued?: number;
  robustnessObservations: { id: string; detail: string }[];
}

export type ChaosGroup =
  | "c1-unmodified"
  | "c1-scaffolded"
  | "r3-after"
  | "c1-control"
  | "c1-control-real-schema"
  | "c2-unmodified"
  | "c2-scaffolded"
  | "c2-long"
  | "c2-nofault-advisory"
  | "c2-control"
  | "c3-baseline"
  | "c3-reaperstall-nofault"
  | "c3-unmodified"
  | "c3-scaffolded"
  | "c3-control"
  | "r1-after"
  | "r2-after"
  | "r4-after"
  | "r5-before"
  | "r5-after"
  | "r7-after";

export interface LoadedChaosReport {
  file: string;
  report: ChaosReport;
  group: ChaosGroup;
}

export function isChaosReport(value: unknown): value is ChaosReport {
  const v = value as Partial<ChaosReport> | null;
  return (
    !!v &&
    typeof v.label === "string" &&
    typeof v.ranAt === "string" &&
    typeof v.args?.fault === "string" &&
    Array.isArray(v.oracles) &&
    typeof v.correctnessViolation === "boolean" &&
    typeof v.k6?.statusTally === "object" &&
    Array.isArray(v.app?.exits) &&
    Array.isArray(v.robustnessObservations)
  );
}

// The harness's own labelling is the taxonomy: C2 prefixes its runs `c2-`
// (the matrix), `c2long-`, `c2adv-` and `c2ctl-`; C3's runHolds.ts reports
// carry `args.mode`; C1's runs are the unprefixed remainder, its controls
// `negctl-*`. Issue #53's reruns against the fixed code are labelled `r1-after-`
// whichever harness produced them: they get a group of their own so the
// "before" aggregates (A-D, the claims check, the finding evidence) stay
// exactly what the pre-fix evidence says.
export function classify(report: ChaosReport): ChaosGroup {
  const l = report.label;
  const survive = !!report.args.surviveUncaught;
  // R3 (#55) reruns run the code *with* the fix: their own group, never counted
  // among the scaffolded runs above (checked first: C3's carry `args.mode`).
  if (l.startsWith("r3-after")) return "r3-after";
  // R4 (#56) reruns run the code *with* the timeouts (ADR-0026): their own group.
  if (l.startsWith("r4-after")) return "r4-after";
  // R5 (#58): `r5-before` reruns the same cells on the code *without* the fix,
  // `r5-after` with it (ADR-0027). Neither belongs among the pre-fix aggregates.
  if (l.startsWith("r5-before")) return "r5-before";
  if (l.startsWith("r5-after")) return "r5-after";
  if (l.startsWith("r1-after-")) return "r1-after";
  // R7 (#57): the reaper-stall reruns and their negative controls against the
  // code with the SKIP LOCKED sweep (ADR-0028); checked before `args.mode`,
  // which every C3 report carries.
  if (l.startsWith("r7-")) return "r7-after";
  if (report.args.mode) {
    if (report.args.expectViolations) return "c3-control";
    if (report.args.fault === "none") {
      return (report.args.reaperStallSeats ?? 0) > 0 ? "c3-reaperstall-nofault" : "c3-baseline";
    }
    return survive ? "c3-scaffolded" : "c3-unmodified";
  }
  if (l.startsWith("r2-after")) return "r2-after";
  if (l.startsWith("c2ctl-")) return "c2-control";
  if (l.startsWith("c2adv-")) return "c2-nofault-advisory";
  if (l.startsWith("c2long-")) return "c2-long";
  if (l.startsWith("c2-")) return survive ? "c2-scaffolded" : "c2-unmodified";
  if (l.startsWith("negctl-")) return report.args.expectViolations ? "c1-control" : "c1-control-real-schema";
  return survive ? "c1-scaffolded" : "c1-unmodified";
}

export async function loadChaosReports(dir: URL): Promise<LoadedChaosReport[]> {
  const entries = (await readdir(dir)).filter((e) => e.endsWith(".json") && !e.startsWith(".")).sort();
  const out: LoadedChaosReport[] = [];
  for (const file of entries) {
    const parsed: unknown = JSON.parse(await readFile(new URL(file, dir), "utf8"));
    if (!isChaosReport(parsed)) continue;
    out.push({ file, report: parsed, group: classify(parsed) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers

const MECHS = ["naive", "unique_constraint", "pessimistic", "optimistic", "advisory", "serializable"];
const LOADS = ["hammer-seat", "deadlock-pairs"];
const C2_FAULTS = ["latency-below", "latency-above", "partition-stall", "partition-reset", "app-sigkill"];

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const inGroups = (all: LoadedChaosReport[], ...groups: ChaosGroup[]): LoadedChaosReport[] =>
  all.filter((x) => groups.includes(x.group));
const reportsOf = (xs: LoadedChaosReport[]): ChaosReport[] => xs.map((x) => x.report);
const tallyOf = (r: ChaosReport, status: string): number => r.k6.statusTally[status] ?? 0;
const crashed = (r: ChaosReport): boolean => r.app.exits.length > 0;
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

function fmtSeconds(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

// 5xx other than 503, 502 and 504: 503 is the designed `retry_exhausted` outcome
// (ADR-0012); 502 is the designed infrastructure-failure outcome (ADR-0025,
// R3 fix) and 504 the designed timeout outcome (ADR-0026, R4 fix) — runs
// recorded before those fixes have none.
function unclassified5xx(r: ChaosReport): number {
  return sum(
    Object.entries(r.k6.statusTally)
      .filter(([k]) => k.startsWith("5") && k !== "503" && k !== "502" && k !== "504")
      .map(([, v]) => v),
  );
}

function infrastructure502(r: ChaosReport): number {
  return r.k6.statusTally["502"] ?? 0;
}

// ---------------------------------------------------------------------------
// R3 (#55): the masked-error / unclassified-500 fix, re-measured. Reports
// labelled `r3-after*` come from the code *with* ADR-0025 (and, like their
// "before" twins, with the `--survive-uncaught` scaffold, because R1 (#53) is
// not part of this change), so they are their own group.

const tallyAll = (rs: ChaosReport[], status: string): number => sum(rs.map((r) => tallyOf(r, status)));
const oraclesClean = (rs: ChaosReport[]): string => `${rs.filter((r) => !r.correctnessViolation).length}/${rs.length}`;

interface R3Cell {
  what: string;
  before: ChaosReport[];
  after: ChaosReport[];
}

function r3Cells(all: LoadedChaosReport[]): R3Cell[] {
  const scaffolded = reportsOf(inGroups(all, "c1-scaffolded", "c2-scaffolded", "c3-scaffolded"));
  const after = reportsOf(inGroups(all, "r3-after"));
  const cells: R3Cell[] = [
    {
      what: "C1 backend-kill (`pessimistic`, `deadlock-pairs`, kill fraction 0.3), scaffolded",
      before: scaffolded.filter((r) => /^survive-kill-rep\d+$/.test(r.label)),
      after: after.filter((r) => /^r3-after-kill-rep\d+$/.test(r.label)),
    },
    {
      // R1 (#53) had landed by then: no scaffold, the real process.
      what: "C1 backend-kill, **unmodified** (no `--survive-uncaught`; R1 merged; the before-runs mostly got no HTTP answer at all because the process exited on the first kill)",
      before: reportsOf(inGroups(all, "c1-unmodified")).filter((r) => r.args.fault === "backend-kill"),
      after: after.filter((r) => /^r3-after-unmodified-kill-rep\d+$/.test(r.label)),
    },
    ...["pessimistic", "serializable", "naive"].map((m) => ({
      what: `C2 \`partition-reset\` (\`${m}\` × \`deadlock-pairs\`)`,
      before: scaffolded.filter((r) => r.args.fault === "partition-reset" && r.args.strategy === m && r.args.load === "deadlock-pairs" && r.label.startsWith("c2-")),
      after: after.filter((r) => r.args.fault === "partition-reset" && r.args.strategy === m && r.args.load === "deadlock-pairs"),
    })),
    {
      what: "C3 hold-confirm, one-shot (`pessimistic`, backend-kill every 10 ms)",
      before: scaffolded.filter((r) => /^c3-survive-hold-confirm-oneshot-rep\d+$/.test(r.label)),
      after: after.filter((r) => /^r3-after-hold-confirm-oneshot-rep\d+$/.test(r.label)),
    },
  ];
  return cells.filter((c) => c.before.length > 0 || c.after.length > 0);
}

function renderR3FixSummary(all: LoadedChaosReport[]): string {
  const cells = r3Cells(all);
  if (cells.every((c) => c.after.length === 0)) return "not yet re-measured";
  const b500 = sum(cells.map((c) => tallyAll(c.before, "500")));
  const a500 = sum(cells.map((c) => tallyAll(c.after, "500")));
  const a502 = sum(cells.map((c) => tallyAll(c.after, "502")));
  const runs = sum(cells.map((c) => c.after.length));
  return `across ${runs} scaffolded reruns of the cells below, client-visible unclassified 500s fell from ${fmtInt(b500)} (the same cells' committed before-runs) to ${fmtInt(a500)}, and ${fmtInt(a502)} requests were answered the designed \`502\` instead (section E)`;
}

function renderR3After(all: LoadedChaosReport[]): string {
  const cells = r3Cells(all);
  if (cells.every((c) => c.after.length === 0)) return "_No `r3-after*` reports yet._";
  const rows = cells.flatMap((c) => [
    [c.what, "before", String(c.before.length), fmtInt(tallyAll(c.before, "500")), fmtInt(tallyAll(c.before, "502")), fmtInt(tallyAll(c.before, "201")), fmtInt(tallyAll(c.before, "409")), oraclesClean(c.before)],
    ["", "**after (#55)**", String(c.after.length), fmtInt(tallyAll(c.after, "500")), fmtInt(tallyAll(c.after, "502")), fmtInt(tallyAll(c.after, "201")), fmtInt(tallyAll(c.after, "409")), oraclesClean(c.after)],
  ]);
  const c3 = cells.find((c) => c.what.startsWith("C3"));
  const retry = (rs: ChaosReport[]) => `${fmtInt(sum(rs.map((r) => r.confirmRetry?.tally?.["201"] ?? 0)))} of ${fmtInt(sum(rs.map((r) => r.holdsSeeded ?? 0)))}`;
  return [
    `Same load, Fault and scaffold as the "before" reports (\`--survive-uncaught\`: the scaffolded rows were run before R1 (#53) had merged; the unmodified C1 row was run after it); the "after" runs differ in code (ADR-0025) and, necessarily, in the random timing of each kill or partition, so counts are comparable in kind, not run for run. The C1 and C3 "after" reruns used a throwaway scratch database rather than the shared one.`,
    mdTable(["Cell", "", "Runs", "HTTP 500", "HTTP 502", "HTTP 201", "HTTP 409", "Oracles clean"], rows),
    c3 && c3.after.length > 0
      ? `**Retry still completes every Confirm exactly once.** After the Fault, the replay re-sent each hold's Confirm: ${retry(c3.before)} holds answered \`201\` before the fix, ${retry(c3.after)} after, and the \`Oracle 3 (idempotent recovery: a live Hold's retried Confirm yields exactly one Booking)\` extension passed in ${oraclesClean(c3.after)} reruns. A \`502\` is exactly the signal that this retry is safe.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function kills(r: ChaosReport): number {
  return r.fault?.stats?.terminated ?? 0;
}

function swallowed(r: ChaosReport): number {
  const o = r.robustnessObservations.find((x) => x.id === "uncaught-exceptions-swallowed-by-scaffold");
  const n = o ? Number.parseInt(o.detail, 10) : 0;
  return Number.isNaN(n) ? 0 : n;
}

// Did the Fault actually land on in-flight work? Latency Faults always do;
// the timed Faults only count when app transactions were open at the instant
// they hit (C2's definition, kept identical so the tables reproduce C2's).
function landed(r: ChaosReport): boolean {
  if (r.args.fault === "app-sigkill") return (r.appKill?.openTxAtKill ?? []).some((n) => (n ?? 0) > 0);
  if (r.args.fault.startsWith("partition")) return (r.networkFault?.openTxWhenApplied ?? 0) > 0;
  return true;
}

function sigCount(r: ChaosReport, needle: string): number {
  return sum(Object.entries(r.app.errorSignatures).filter(([k]) => k.includes(needle)).map(([, v]) => v));
}

function oracleVerdicts(r: ChaosReport): string {
  return r.oracles
    .filter((o) => o.oracle <= 4 && !o.name.includes(":"))
    .map((o) => `${o.oracle}${o.passed ? "✓" : "✗"}`)
    .join(" ");
}

function failedOracleNames(r: ChaosReport): string {
  const failed = r.oracles.filter((o) => !o.passed).map((o) => `${o.oracle}:${o.name}`);
  return failed.length ? failed.join("; ") : "none";
}

// One cell of the mechanism x load x Fault matrix — identical wording to C2's
// summarize.ts so the regenerated tables can be diffed against C2's record.
export function matrixCell(rs: ChaosReport[]): string {
  if (rs.length === 0) return "—";
  const n = rs.length;
  const oracleOk = rs.filter((r) => !r.correctnessViolation).length;
  const crashes = rs.filter(crashed).length;
  const eff = rs.filter(landed).length;
  const unack = sum(rs.map((r) => r.ambiguity?.committedUnacknowledged ?? 0));
  const maxTx = Math.max(...rs.map((r) => r.stall?.maxOpenTxAgeMs ?? 0));
  const leaked = rs.filter((r) => r.drain?.timedOut).length;
  const parts = [`${oracleOk === n ? "✅" : "❌"} ${oracleOk}/${n}`, `landed ${eff}/${n}`, `crash ${crashes}/${n}`];
  if (unack > 0) parts.push(`unack ${unack}`);
  parts.push(`tx≤${fmtSeconds(maxTx)}`);
  if (leaked > 0) parts.push(`LEAK ${leaked}`);
  return parts.join(" · ");
}

function mdTable(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Canonical finding numbering (reconciles C1/C2/C3's clashing "R5")

export interface CanonicalFinding {
  id: string;
  title: string;
  klass: string;
  oldNumbers: string;
  draftSlug: string;
}

export const CANONICAL_FINDINGS: CanonicalFinding[] = [
  {
    id: "R1",
    title: "App process exits when a checked-out connection errors (unhandled `Client` `'error'`)",
    klass: "Robustness",
    oldNumbers: "C1 R1 · C2 R1 · C3 R1",
    draftSlug: "R1",
  },
  {
    id: "R2",
    title: "App process exits when an idle pooled connection errors (unhandled `BoundPool` `'error'`)",
    klass: "Robustness",
    oldNumbers: "C1 R2 · C2 R2 (C3: not re-tested)",
    draftSlug: "R2",
  },
  {
    id: "R3",
    title: "`ROLLBACK` on a dead connection masks the original error; infrastructure failure surfaces as an unclassified HTTP 500",
    klass: "Robustness",
    oldNumbers: "C1 R3 · C2 R3 · C3 R3",
    draftSlug: "R3",
  },
  {
    id: "R4",
    title: "No timeouts anywhere: a partition stalls requests, transactions and row locks for its whole duration",
    klass: "Robustness",
    oldNumbers: "C1 R4 (impact pending) · C2 R4 (impact measured) · C3 R4",
    draftSlug: "R4",
  },
  {
    id: "R5",
    title: "`advisory`: stale-snapshot race returns an unclassified HTTP 500 instead of 409 (UNIQUE backstop holds)",
    klass: "Robustness (latent)",
    oldNumbers: "C2 R5 (unchanged)",
    draftSlug: "R5",
  },
  {
    id: "R6",
    title: "Retry loops amplify latency under a slow link (`optimistic`, `serializable`)",
    klass: "Robustness (performance)",
    oldNumbers: "C2 R6 (unchanged)",
    draftSlug: "R6",
  },
  {
    id: "R7",
    title: "A stalled reaper sweep holds row locks on other expired seats and blocks unrelated Hold/Confirm",
    klass: "Robustness",
    oldNumbers: "**C3 R5 → R7** (renumbered; C2's R5 kept the number)",
    draftSlug: "R7",
  },
];

// Findings the formal track's model checking (F4, #47) exposed in the REAL
// implementation. Numbered RF1.. and kept apart from R1-R7 on purpose: no chaos
// run observed them, so nothing below is recomputed from the JSON reports —
// the evidence is a TLC counterexample trace (formal/README.md on main, merge
// 2f47207, section "Findings: behavior the model exposes in the real
// implementation"), cited, not re-run here.
export interface FormalFinding {
  id: string;
  title: string;
  klass: string;
  evidence: string;
  whyChaosMissesIt: string;
  draftSlug: string;
}

export const FORMAL_FINDINGS: FormalFinding[] = [
  {
    id: "RF1",
    title: "Idempotency-key lifetime equals row lifetime: the key is forgotten when its Booking/Hold row is deleted, so a retry after Cancel / reap creates a *second* Booking / Hold",
    klass: "Robustness (formal-derived)",
    evidence:
      "The key's only home is `bookings.idempotency_key` / `holds.idempotency_key` (`UNIQUE`), and ADR-0020 deletes that row on Cancel, Confirm and reap. So book → cancel → retry with the same key creates a second Booking, and hold → expire → reap → retry the same key creates a second, fresh Hold. TLC: `CrashFindingKeyReuse` (`BookingKeyCreatesAtMostOne` violated, trace 10) and `CrashFindingHoldKeyReuse` (`HoldKeyCreatesAtMostOne` violated, trace 11) — invariants violated on purpose in `formal/check.sh`. What *does* hold: `KeyAtMostOneBooking` / `KeyAtMostOneHold` (at most one **live** row per key) and `KeyReuseOnlyAfterRelease`",
    whyChaosMissesIt:
      "Oracle 3 demands \"no key has more than one Booking\" *at the end of the run*, and the stored-state reading is satisfied: after Cancel there is one row, not two. Nothing in the chaos runs cancels a Booking and then replays its key",
    draftSlug: "RF1",
  },
  {
    id: "RF2",
    title: "A concurrent same-key book/hold retry can be answered 409 although the original's key row is already committed (key lookup happens before `BEGIN`)",
    klass: "Robustness (formal-derived)",
    evidence:
      "`bookSeatPessimistic` / `holdSeatsPessimistic` look the key up *before* `BEGIN` (`pessimistic.ts:25`, `pessimisticHold.ts:20`). If the original commits between that lookup and the retry's `FOR UPDATE NOWAIT`, the retry's lock succeeds, sees the seat taken and answers 409 `conflict` instead of replaying; `resolveIdempotencyKeyRace` does not catch it (it fires on a unique violation, reachable under `pessimistic` only for a same-key retry wanting *different* seats). If the original's ack was also lost, the client's only answer is a 409 for a request that succeeded; a *further* retry replays correctly. TLC: `CrashFindingSpuriousConflict` (`KeyNeverFalselyRefused` violated, trace 7). The confirm path is **not** affected (`ConfirmNeverFalselyRefused` holds): `confirmHoldPessimistic` repeats its key lookup inside the transaction. The same pre-`BEGIN` lookup also appears in `naive.ts:37` and `advisory.ts:37`; whether it yields a spurious 409 there depends on each mechanism's conflict path and was **not modeled** (F4 models `pessimistic` only)",
    whyChaosMissesIt:
      "the Oracles read stored state after the Fault clears; the Booking *exists*, exactly once, so Oracles 1–3 pass. The wrong answer is an HTTP status the client saw, which ADR-0022 deliberately never treats as evidence, and the chaos loads do not issue a same-key retry that overlaps the original's commit",
    draftSlug: "RF2",
  },
];

// ---------------------------------------------------------------------------
// Evidence behind each finding, recomputed from the reports

export interface FindingEvidence {
  r1: {
    unmodifiedFaultRuns: number;
    crashed: number;
    clientEvent: number;
    boundPoolEvent: number;
    byGroup: { label: string; crashed: number; total: number }[];
  };
  r2: { idlePoolRuns: number; crashed: number; boundPoolEvent: number; partitionStallBoundPoolOnly: number };
  r3: {
    scaffoldedClientVisible500: number;
    scaffoldedLoggedDeadConnectionErrors: number;
    scaffoldedStallLogged: number;
    scaffoldedStallClientVisible500: number;
    scaffoldedRuns: number;
  };
  r4: {
    partitionStallRuns: number;
    outlived: number;
    longestTxMsStall: number;
    longestTxMsLong: number;
    leaked: number;
    longestDrainMs: number;
  };
  r5: { matrixRuns: number; matrixHits: string[]; noFaultRuns: number; noFault500: number };
  r6: { mech: string; load: string; timeouts: number; of: number; r503: number; p95MinMs: number; p95MaxMs: number }[];
  r7: {
    baselineFreshHoldWins: number;
    controlFreshHoldWins: number;
    baseline409: number;
    control409: number;
    sweepsKilledUnmodified: number;
    sweepsKilledScaffolded: number;
  };
}

const BOUNDPOOL = "Emitted 'error' event on BoundPool";
const CLIENT_EVENT = "Emitted 'error' event on Client";
// Exact signature keys, so "Reaper sweep failed: Error: Connection terminated…" lines are not counted as request errors.
const DEAD_CONN = ["Error: Client has encountered a connection error and is not queryable", "Error: Connection terminated unexpectedly"];

export function computeFindingEvidence(all: LoadedChaosReport[]): FindingEvidence {
  const c1u = reportsOf(inGroups(all, "c1-unmodified"));
  const c2u = reportsOf(inGroups(all, "c2-unmodified"));
  const c3u = reportsOf(inGroups(all, "c3-unmodified"));
  const faultBearing = (rs: ChaosReport[], pred: (r: ChaosReport) => boolean) => rs.filter(pred);

  const r1Groups = [
    { label: "C1 backend-kill (`pessimistic`, `deadlock-pairs`)", rs: faultBearing(c1u, (r) => r.args.fault === "backend-kill") },
    { label: "C2 `partition-stall` (six mechanisms)", rs: c2u.filter((r) => r.args.fault === "partition-stall") },
    { label: "C2 `partition-reset` (six mechanisms)", rs: c2u.filter((r) => r.args.fault === "partition-reset") },
    { label: "C3 backend-kill on the hold flow (`pessimistic`)", rs: c3u },
  ];
  const r1All = r1Groups.flatMap((g) => g.rs);

  const idle = c1u.filter((r) => r.args.fault === "idle-pool-kill");
  const stallCrashed = c2u.filter((r) => r.args.fault === "partition-stall" && crashed(r));

  const scaffolded = reportsOf(inGroups(all, "c1-scaffolded", "c2-scaffolded", "c3-scaffolded"));
  const c2stallAll = reportsOf(inGroups(all, "c2-unmodified", "c2-scaffolded")).filter((r) => r.args.fault === "partition-stall");
  const matrix = reportsOf(inGroups(all, "c2-unmodified", "c2-scaffolded"));
  const c2stallScaffolded = reportsOf(inGroups(all, "c2-scaffolded")).filter((r) => r.args.fault === "partition-stall");
  const longRuns = reportsOf(inGroups(all, "c2-long"));

  // R5 is identified by its own signature (the UNIQUE backstop refusing an
  // INSERT the mechanism's racy check let through), NOT by "any HTTP 500":
  // scaffolded partition runs answer thousands of 500s for R3's reason.
  const DUP_KEY = "duplicate key value violates unique constraint";
  const advNoFault = reportsOf(inGroups(all, "c2-nofault-advisory"));
  const has500 = (r: ChaosReport) => tallyOf(r, "500") > 0 || (r.replay?.tally["500"] ?? 0) > 0;

  const latBelow = c2u.filter((r) => r.args.fault === "latency-below");
  const r6 = MECHS.flatMap((mech) =>
    LOADS.map((load) => {
      const rs = latBelow.filter((r) => r.args.strategy === mech && r.args.load === load);
      const p95 = rs.map((r) => r.k6.p95RequestMs ?? 0);
      return {
        mech,
        load,
        timeouts: sum(rs.map((r) => r.k6.clientTimeouts ?? 0)),
        of: sum(rs.map((r) => r.requestsIssued ?? 0)),
        r503: sum(rs.map((r) => tallyOf(r, "503"))),
        p95MinMs: p95.length ? Math.min(...p95) : 0,
        p95MaxMs: p95.length ? Math.max(...p95) : 0,
      };
    }),
  );

  const c3 = (g: ChaosGroup) => reportsOf(inGroups(all, g))[0];
  const base = c3("c3-baseline");
  const baseExpiry = reportsOf(inGroups(all, "c3-baseline")).find((r) => r.args.mode === "hold-expiry") ?? base;
  const ctl = c3("c3-reaperstall-nofault");

  const drains = matrix.map((r) => r.drain?.drainedAfterMs).filter((d): d is number => typeof d === "number");

  return {
    r1: {
      unmodifiedFaultRuns: r1All.length,
      crashed: r1All.filter(crashed).length,
      clientEvent: r1All.filter((r) => sigCount(r, CLIENT_EVENT) > 0).length,
      boundPoolEvent: r1All.filter((r) => sigCount(r, BOUNDPOOL) > 0).length,
      byGroup: r1Groups.map((g) => ({ label: g.label, crashed: g.rs.filter(crashed).length, total: g.rs.length })),
    },
    r2: {
      idlePoolRuns: idle.length,
      crashed: idle.filter(crashed).length,
      boundPoolEvent: idle.filter((r) => sigCount(r, BOUNDPOOL) > 0).length,
      partitionStallBoundPoolOnly: stallCrashed.filter((r) => sigCount(r, BOUNDPOOL) > 0 && sigCount(r, CLIENT_EVENT) === 0).length,
    },
    r3: {
      scaffoldedClientVisible500: sum(scaffolded.map((r) => tallyOf(r, "500"))),
      scaffoldedLoggedDeadConnectionErrors: sum(scaffolded.map((r) => sum(DEAD_CONN.map((s) => r.app.errorSignatures[s] ?? 0)))),
      scaffoldedStallLogged: sum(c2stallScaffolded.map((r) => sum(DEAD_CONN.map((s) => r.app.errorSignatures[s] ?? 0)))),
      scaffoldedStallClientVisible500: sum(c2stallScaffolded.map((r) => tallyOf(r, "500"))),
      scaffoldedRuns: scaffolded.length,
    },
    r4: {
      partitionStallRuns: c2stallAll.length,
      outlived: c2stallAll.filter((r) => r.robustnessObservations.some((o) => o.id === "transaction-outlived-client-timeout")).length,
      longestTxMsStall: Math.max(0, ...c2stallAll.map((r) => r.stall?.maxOpenTxAgeMs ?? 0)),
      longestTxMsLong: Math.max(0, ...longRuns.map((r) => r.stall?.maxOpenTxAgeMs ?? 0)),
      leaked: matrix.filter((r) => r.drain?.timedOut).length,
      longestDrainMs: drains.length ? Math.max(...drains) : 0,
    },
    r5: {
      matrixRuns: matrix.length,
      matrixHits: matrix.filter((r) => sigCount(r, DUP_KEY) > 0).map((r) => r.label),
      noFaultRuns: advNoFault.length,
      noFault500: advNoFault.filter(has500).length,
    },
    r6,
    r7: {
      baselineFreshHoldWins: baseExpiry ? tallyOf(baseExpiry, "201") : 0,
      controlFreshHoldWins: ctl ? tallyOf(ctl, "201") : 0,
      baseline409: baseExpiry ? tallyOf(baseExpiry, "409") : 0,
      control409: ctl ? tallyOf(ctl, "409") : 0,
      sweepsKilledUnmodified: sum(reportsOf(inGroups(all, "c3-unmodified")).map((r) => r.app.reaperSweepFailures ?? 0)),
      sweepsKilledScaffolded: sum(reportsOf(inGroups(all, "c3-scaffolded")).map((r) => r.app.reaperSweepFailures ?? 0)),
    },
  };
}

// ---------------------------------------------------------------------------
// Record-consistency check: re-derive each number the C1/C2/C3 prose records
// quote and flag any that disagree with the JSON.

export interface ClaimRow {
  source: string;
  claim: string;
  quoted: string;
  computed: string;
  match: boolean;
}

function claim(source: string, text: string, quoted: string | number, computed: string | number): ClaimRow {
  const q = String(quoted);
  const c = String(computed);
  return { source, claim: text, quoted: q, computed: c, match: q === c };
}

export function checkRecordClaims(all: LoadedChaosReport[]): ClaimRow[] {
  const rows: ClaimRow[] = [];
  const g = (...gs: ChaosGroup[]) => reportsOf(inGroups(all, ...gs));

  // --- C1
  const c1u = g("c1-unmodified");
  const c1bk = c1u.filter((r) => r.args.fault === "backend-kill");
  const c1s = g("c1-scaffolded");
  rows.push(claim("C1", "unmodified backend-kill runs where the app crashed", "4/4", `${c1bk.filter(crashed).length}/${c1bk.length}`));
  rows.push(claim("C1", "scaffolded runs", 6, c1s.length));
  rows.push(claim("C1", "mid-transaction kills across the scaffolded runs", 59, sum(c1s.map(kills))));
  rows.push(claim("C1", "HTTP 500s across the scaffolded runs", 53, sum(c1s.map((r) => tallyOf(r, "500")))));
  const reruns = c1bk.filter((r) => r.label.startsWith("unmodified-kill-rep")).sort((a, b) => a.label.localeCompare(b.label));
  rows.push(claim("C1", "requests unanswered in unmodified reruns 1-3 (of 120)", "119/114/110", reruns.map((r) => tallyOf(r, "0")).join("/")));
  const winners = g("c1-control")
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((r) => /claimed by (\d+)/.exec(r.oracles.find((o) => o.oracle === 1)?.violations[0]?.detail ?? "")?.[1] ?? "?");
  rows.push(claim("C1", "winners Oracle 1 found on one seat, negative-control reps 1-3", "13/7/8", winners.join("/")));
  rows.push(claim("C1", "negative-control runs flagged by Oracle 1", "3/3", `${g("c1-control").filter((r) => r.oracles.some((o) => o.oracle === 1 && !o.passed)).length}/${g("c1-control").length}`));

  // --- C2
  const c2u = g("c2-unmodified");
  const c2s = g("c2-scaffolded");
  const c2 = [...c2u, ...c2s];
  rows.push(claim("C2", "matrix runs (unmodified + scaffolded)", "420 (300+120)", `${c2.length} (${c2u.length}+${c2s.length})`));
  rows.push(claim("C2", "Correctness violations in the matrix", 0, c2.filter((r) => r.correctnessViolation).length));
  const ctl = g("c2-control");
  rows.push(claim("C2", "end-to-end controls flagged by Oracle 1", "10/10", `${ctl.filter((r) => r.oracles.some((o) => o.oracle === 1 && !o.passed)).length}/${ctl.length}`));
  const lAbove = c2u.filter((r) => r.args.fault === "latency-above");
  rows.push(claim("C2", "latency-above: requests that timed out client-side", "3600/3600", `${sum(lAbove.map((r) => r.k6.clientTimeouts ?? 0))}/${sum(lAbove.map((r) => r.requestsIssued ?? 0))}`));
  rows.push(claim("C2", "Bookings committed that no client was told about (matrix)", 1434, sum(c2.map((r) => r.ambiguity?.committedUnacknowledged ?? 0))));
  rows.push(claim("C2", "…of which latency-above", 854, sum(lAbove.map((r) => r.ambiguity?.committedUnacknowledged ?? 0))));
  const pStall = c2u.filter((r) => r.args.fault === "partition-stall");
  const pReset = c2u.filter((r) => r.args.fault === "partition-reset");
  rows.push(claim("C2", "partition-stall unmodified runs that crashed", "60/60", `${pStall.filter(crashed).length}/${pStall.length}`));
  rows.push(claim("C2", "…crashes via Client / BoundPool event", "51/9", `${pStall.filter((r) => sigCount(r, CLIENT_EVENT) > 0).length}/${pStall.filter((r) => sigCount(r, BOUNDPOOL) > 0).length}`));
  rows.push(claim("C2", "partition-reset unmodified runs that crashed", "52/60", `${pReset.filter(crashed).length}/${pReset.length}`));
  const resetLanded = pReset.filter(landed);
  rows.push(claim("C2", "partition-reset: crashed where the cut hit in-flight work", "42/42", `${resetLanded.filter(crashed).length}/${resetLanded.length}`));
  rows.push(
    claim(
      "C2",
      "Fault landed on in-flight transactions: stall / reset / sigkill, unmodified",
      "49/60, 42/60, 57/60",
      ["partition-stall", "partition-reset", "app-sigkill"].map((f) => { const xs = c2u.filter((r) => r.args.fault === f); return `${xs.filter(landed).length}/${xs.length}`; }).join(", "),
    ),
  );
  rows.push(
    claim(
      "C2",
      "Fault landed: stall / reset, scaffolded",
      "46/60, 48/60",
      ["partition-stall", "partition-reset"].map((f) => { const xs = c2s.filter((r) => r.args.fault === f); return `${xs.filter(landed).length}/${xs.length}`; }).join(", "),
    ),
  );
  const stallAll = c2.filter((r) => r.args.fault === "partition-stall");
  rows.push(claim("C2", "partition-stall runs flagged transaction-outlived-client-timeout", "92/120", `${stallAll.filter((r) => r.robustnessObservations.some((o) => o.id === "transaction-outlived-client-timeout")).length}/${stallAll.length}`));
  rows.push(claim("C2", "HTTP 500s on scaffolded partition-reset", 3109, sum(c2s.filter((r) => r.args.fault === "partition-reset").map((r) => tallyOf(r, "500")))));
  const drains = c2.map((r) => r.drain?.drainedAfterMs).filter((d): d is number => typeof d === "number");
  const maxDrain = Math.max(...drains);
  rows.push(claim("C2", "every transaction drained within 135 ms, none leaked (bound, leaks)", "≤135 ms, 0", `${maxDrain <= 135 ? "≤135 ms" : `${maxDrain} ms`}, ${c2.filter((r) => r.drain?.timedOut).length}`));
  const kill = c2.filter((r) => r.args.fault === "app-sigkill");
  const restarts = kill.flatMap((r) => r.appKill?.restartMs ?? []).sort((a, b) => a - b);
  rows.push(claim("C2", "app-sigkill: kills / unacknowledged commits", "60 / 65", `${sum(kill.map((r) => r.appKill?.kills ?? 0))} / ${sum(kill.map((r) => r.ambiguity?.committedUnacknowledged ?? 0))}`));
  rows.push(claim("C2", "app-sigkill restart min/median/max (ms)", "653/654/805", restarts.length ? `${restarts[0]}/${restarts[Math.floor(restarts.length / 2)]}/${restarts[restarts.length - 1]}` : "n/a"));
  const ev = computeFindingEvidence(all);
  const optH = ev.r6.find((r) => r.mech === "optimistic" && r.load === "hammer-seat");
  const serD = ev.r6.find((r) => r.mech === "serializable" && r.load === "deadlock-pairs");
  rows.push(claim("C2", "R6: optimistic hammer-seat client timeouts at 100 ms/chunk", "130/300", `${optH?.timeouts}/${optH?.of}`));
  rows.push(claim("C2", "R6: serializable deadlock-pairs timeouts / 503s", "37 / 206", `${serD?.timeouts} / ${serD?.r503}`));
  const others = ev.r6.filter((r) => !(r.mech === "optimistic" && r.load === "hammer-seat") && !(r.mech === "serializable" && r.load === "deadlock-pairs") && ["naive", "unique_constraint", "pessimistic", "advisory"].includes(r.mech));
  rows.push(claim("C2", "R6: the other four mechanisms never time out (total timeouts)", 0, sum(others.map((r) => r.timeouts))));
  const lo = Math.min(...others.map((r) => r.p95MinMs));
  const hi = Math.max(...others.map((r) => r.p95MaxMs));
  rows.push(claim("C2", "R6: those four mechanisms' p95 under latency-below", "~1.1-1.3 s", `${(lo / 1000).toFixed(1)}-${(hi / 1000).toFixed(1)} s`));
  rows.push(claim("C2", "R5: runs logging the advisory duplicate-key 500, matrix / no-Fault reruns", "1 in 420 / 0 in 20", `${ev.r5.matrixHits.length} in ${ev.r5.matrixRuns} / ${ev.r5.noFault500} in ${ev.r5.noFaultRuns}`));
  const long = g("c2-long");
  const longMax = (m: string, survive: boolean) => long.find((r) => r.args.strategy === m && !!r.args.surviveUncaught === survive)?.k6.maxRequestMs;
  rows.push(
    claim(
      "C2",
      "long-partition slowest request (ms): pessimistic / advisory / serializable / pessimistic scaffolded",
      "30261/30297/30294/30325",
      [longMax("pessimistic", false), longMax("advisory", false), longMax("serializable", false), longMax("pessimistic", true)].join("/"),
    ),
  );
  // The record's "120/100" and "400/250" are (partition jitter, app-SIGKILL jitter)
  // pairs for hammer-seat reps 4-5 and reps 1-3 (matrix.ts's JITTER_MS); the
  // SIGKILL runs store theirs in the same `partitionJitterMs` field.
  const jitterOf = (fault: string, reps: RegExp) =>
    uniq(c2.filter((r) => r.args.fault === fault && r.args.load === "hammer-seat" && reps.test(r.label)).map((r) => r.args.partitionJitterMs)).join("+");
  const jitterPair = (reps: RegExp) => `${jitterOf("partition-stall", reps)}/${jitterOf("app-sigkill", reps)}`;
  rows.push(
    claim("C2", "hammer-seat jitter, partition/SIGKILL (ms): reps 4-5 and reps 1-3", "120/100 and 400/250", `${jitterPair(/-rep[45]$/)} and ${jitterPair(/-rep[123]$/)}`),
  );

  // --- C3
  const c3 = g("c3-baseline", "c3-reaperstall-nofault", "c3-unmodified", "c3-scaffolded", "c3-control");
  const c3m = c3.filter((r) => !r.args.expectViolations);
  rows.push(claim("C3", "report files", 52, c3.length));
  rows.push(claim("C3", "measured runs / Correctness violations among them", "49 / 0", `${c3m.length} / ${c3m.filter((r) => r.correctnessViolation).length}`));
  rows.push(claim("C3", "end-to-end controls flagged", "3/3", `${g("c3-control").filter((r) => r.correctnessViolation).length}/${g("c3-control").length}`));
  const c3u = g("c3-unmodified");
  rows.push(claim("C3", "unmodified Fault runs that crashed (incl. as-found first runs)", "18/18", `${c3u.filter(crashed).length}/${c3u.length}`));
  rows.push(claim("C3", "uncaught exceptions swallowed by the scaffold", 457, sum(c3.map(swallowed))));
  const oneshot = g("c3-scaffolded").filter((r) => r.args.attemptsPerHold === 1);
  rows.push(claim("C3", "one-shot: kills / Confirms answered 500 / completed by retry / Holds with exactly one Booking", "274 / 258 / 258 / 800", `${sum(oneshot.map(kills))} / ${sum(oneshot.map((r) => tallyOf(r, "500")))} / ${sum(oneshot.map((r) => r.confirmRetry?.createdByRetry ?? 0))} / ${sum(oneshot.map((r) => r.confirmRetry?.tally["201"] ?? 0))}`));
  const uc = g("c3-unmodified").filter((r) => r.label.startsWith("c3-unmodified-hold-confirm"));
  const created = uc.map((r) => r.confirmRetry?.createdByRetry ?? 0);
  rows.push(claim("C3", "unmodified hold-confirm: Bookings created by the retry after a crash (min–max of 40)", "5–32", `${Math.min(...created)}–${Math.max(...created)}`));
  rows.push(claim("C3", "reaper sweeps killed mid-flight: unmodified / scaffolded", "7 / 24", `${ev.r7.sweepsKilledUnmodified} / ${ev.r7.sweepsKilledScaffolded}`));
  rows.push(claim("C3", "reaper stall: fresh Holds won, stalled vs baseline (of 12)", "0 vs 12", `${ev.r7.controlFreshHoldWins} vs ${ev.r7.baselineFreshHoldWins}`));
  rows.push(claim("C3", "reaper stall: 409s stalled vs baseline", "623 vs 527", `${ev.r7.control409} vs ${ev.r7.baseline409}`));
  return rows;
}

// ---------------------------------------------------------------------------
// Static unit-control counts, read from the test files themselves

export interface UnitControlCount {
  file: string;
  tests: number;
}

const TEST_LINE = /^\s*(?:it|test)(?:\.skipIf\([^)]*\))?\(/gm;

export async function countUnitControls(testDir: URL, files: string[]): Promise<UnitControlCount[] | null> {
  try {
    const out: UnitControlCount[] = [];
    for (const file of files) {
      const text = await readFile(new URL(file, testDir), "utf8");
      out.push({ file, tests: (text.match(TEST_LINE) ?? []).length });
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering

function renderHeadline(all: LoadedChaosReport[], fileCount: number, r5BeforeCount = 0): string {
  const controls = all.filter((x) => x.report.args.expectViolations);
  const measured = all.filter((x) => !x.report.args.expectViolations);
  const withFault = measured.filter((x) => x.report.args.fault !== "none");
  const violations = measured.filter((x) => x.report.correctnessViolation);
  const flagged = controls.filter((x) => x.report.correctnessViolation);
  const unmodFault = withFault.filter((x) => !x.report.args.surviveUncaught);
  const scaffoldFault = withFault.filter((x) => x.report.args.surviveUncaught);
  const twins = inGroups(all, "c1-control-real-schema");
  return mdTable(
    ["", ""],
    [
      ["Report files read (`docs/evidence/chaos/*.json`)", `**${fmtInt(fileCount)}** — ${fmtInt(all.length)} pre-fix (everything below except sections E, G, H and I), ${fmtInt(fileCount - all.length - r5BeforeCount)} post-fix reruns (\`r1-after-*\`, issue #53, section E; \`r4-after-*\`, issue #56, section G; \`r2-after-*\`, issue #54, section H; \`r5-after-*\`, issue #58, section I) and ${fmtInt(r5BeforeCount)} \`r5-before-*\` reruns of the same cells on the code without #58's fix (section I); the post-fix count also includes the \`r7-after-*\`/\`r7-negctl-*\` reruns, issue #57, section J`],
      ["Measured runs (every run that is not a negative control)", `**${fmtInt(measured.length)}** — ${fmtInt(withFault.length)} under a Fault (${fmtInt(unmodFault.length)} on unmodified code, ${fmtInt(scaffoldFault.length)} with the \`--survive-uncaught\` scaffold), ${fmtInt(measured.length - withFault.length)} no-Fault baselines/reruns`],
      ["**Correctness violations** in measured runs (any Oracle failing)", `**${violations.length}**${violations.length ? ` (${violations.map((v) => v.report.label).join(", ")})` : ""}`],
      ["Negative controls that went red as required", `**${flagged.length} of ${controls.length}** end-to-end (\`expectViolations\`); the control's control on the real schema stayed green in ${twins.filter((t) => !t.report.correctnessViolation).length} of ${twins.length}`],
      ["Robustness findings (canonical numbering)", `**${CANONICAL_FINDINGS.length}** chaos-observed (R1–R7) + **${FORMAL_FINDINGS.length}** formal-derived (RF1–RF2, found by model checking, not by a chaos run); R1 fixed by #53 (section E), R2 by #54 (section H), R3 by #55 (section F), R4 by #56 (section G), R5 by #58 (section I), R7 by #57 (section J); the other three are not fixed and filed as fix tickets #59–#61 (drafts in \`docs/phase6-robustness-ticket-drafts.md\`)`],
      ["Production code changed", "None by the chaos tickets themselves (C1–C5: `src/` and `db/schema.sql` untouched, measure-first policy, ADR-0022). The fixes so far change `src/` only — #53 `src/db/pool.ts` (ADR-0024), #55 `src/db/pool.ts`, `src/db/pgErrors.ts`, `src/app.ts` (ADR-0025), #56 adds the timeouts of ADR-0026 (`src/config.ts`, `src/db/poolOptions.ts`, `src/db/queryDeadline.ts`, `src/db/pgErrors.ts`, `src/app.ts`, a hook appended to `src/db/pool.ts`); #58 splits `advisory.ts`'s lock-and-read statement in two (`src/strategies/advisory.ts`, ADR-0027); #57 rewrites the reaper's sweep statement to skip row-locked seats (`src/reaper.ts`, ADR-0028); #54 changes no production code (the `pool.on(\"error\")` listener that closes R2 shipped with #53; #54 adds its regression test and the idle-path evidence); `db/schema.sql` is still untouched"],
    ],
  );
}

function renderFaultParameters(all: LoadedChaosReport[]): string {
  const c2 = reportsOf(inGroups(all, "c2-unmodified", "c2-scaffolded"));
  const by = (f: string) => c2.filter((r) => r.args.fault === f);
  const to = uniq(c2.map((r) => r.args.requestTimeoutMs)).join("/");
  const lb = uniq(by("latency-below").map((r) => r.networkFault?.latencyMs)).join("/");
  const la = uniq(by("latency-above").map((r) => r.networkFault?.latencyMs)).join("/");
  const pd = uniq(by("partition-stall").map((r) => r.networkFault?.partitionDurationMs)).join("/");
  const pbase = uniq(by("partition-stall").map((r) => r.baseLatencyMs)).join("/");
  const rows: string[][] = [
    [
      "`backend-kill`",
      "`pg_terminate_backend` on app backends that are inside a transaction (active mid-statement or idle-in-transaction), swept every 40 ms (10 ms for C3's one-shot Confirm runs), each eligible backend killed with probability 0.5 (0.3 for scaffolded runs). Harness connections exempt by `application_name`.",
      "C1: `pessimistic` × `deadlock-pairs` (60 pairs). C3: hold-expiry / hold-confirm",
      String(reportsOf(inGroups(all, "c1-unmodified", "c1-scaffolded", "c3-unmodified", "c3-scaffolded")).filter((r) => r.args.fault === "backend-kill").length),
    ],
    [
      "`idle-pool-kill`",
      "After the load completes, every idle pooled connection is killed in one sweep (no request in flight)",
      "C1 only",
      String(reportsOf(inGroups(all, "c1-unmodified")).filter((r) => r.args.fault === "idle-pool-kill").length),
    ],
    [
      "`latency-below`",
      `Toxiproxy \`latency\` toxic, ${lb} ms on every Postgres→app chunk (each protocol round trip costs +${lb} ms), below the ${to} ms client request timeout`,
      "C2: six mechanisms × `hammer-seat`/`deadlock-pairs`, 5 reps",
      String(by("latency-below").length),
    ],
    [
      "`latency-above`",
      `Same toxic at ${la} ms/chunk: connection setup alone (~4 chunks) plus 6+ round trips per booking exceeds the ${to} ms timeout, so every request times out client-side while its transaction still commits server-side (an Ambiguous outcome). Toxic removed at load end; removal flushes buffered bytes.`,
      "C2, as above",
      String(by("latency-above").length),
    ],
    [
      "`partition-stall`",
      `Toxiproxy \`timeout\` toxic (timeout=0) both directions: traffic swallowed, connections stay open. Applied 20–420 ms after the first app transaction appears in Postgres, held ${pd} ms (> the ${to} ms timeout), then healed. Base latency ${pbase} ms/chunk so cuts land mid-transaction. **Toxiproxy's heal tears the stalled connections down** (it does not resume them).`,
      "C2, as above (unmodified and scaffolded)",
      String(by("partition-stall").length),
    ],
    [
      "`partition-reset`",
      `Toxiproxy \`reset_peer\` toxic both directions: every connection RST for ${uniq(by("partition-reset").map((r) => r.networkFault?.partitionDurationMs)).join("/")} ms, same timing and base latency as above`,
      "C2, as above (unmodified and scaffolded)",
      String(by("partition-reset").length),
    ],
    [
      "`app-sigkill`",
      "`SIGKILL` of the app's whole process tree (the `tsx` wrapper and its server child) 20–270 ms after the first app transaction, then the harness restarts it (~650 ms). One kill per run.",
      "C2, as above",
      String(by("app-sigkill").length),
    ],
    ["Postgres restart", "**Not run.** C4 (#51) is the stretch item in the cut order and was not started.", "—", "0"],
  ];
  return mdTable(["Fault", "What it does (parameters read from the reports)", "Where", "Runs"], rows);
}

function renderOracleDefinitions(): string {
  return `All four are SQL against stored state after the Fault has cleared (\`load-harness/chaos/oracles.ts\`, ADR-0022); the only HTTP-derived input is the Idempotency-Key replay, which is an *action*, not evidence. Oracle 2 needs the intended seat set per request, which only the harness's client-side ledger of intent (key → requested seats) can supply.

${mdTable(
  ["#", "Oracle", "Fails (Correctness violation) when…"],
  [
    ["1", "Mutual exclusion", "a Seat is claimed by more than one Booking/Hold (or by a Booking and a Hold at once), or `seats` disagrees with the claim rows about who owns it"],
    ["2", "No torn state", "a Booking holds fewer/other Seats than its Idempotency Key requested, or a Seat is `booked` with no Booking"],
    ["3", "Idempotent recovery", "after the Fault clears and every key is re-sent, a key has more than one Booking, or a key's existing Booking changed under the replay (a key that lost its seat legitimately has none, so \"exactly one\" is *not* demanded of every key)"],
    ["4", "Liveness", "a Seat is `held` without a Hold, `held` past expiry + grace, or still row-locked by a transaction that never ended"],
    ["2 ext", "No Booking from an expired Hold (C3, `holdOracles.ts`)", "a Booking exists under `hold-confirm:<holdId>` with `created_at >= held_until`, using the Hold's `held_until` snapshotted from the database before the Fault"],
    ["3 ext", "A live Hold's retried Confirm yields exactly one Booking (C3)", "a provably live Hold ends with zero, or more than one, Booking after Confirm was retried (the base Oracle 3 only demands \"at most one\")"],
  ],
)}`;
}

function renderUnitControls(counts: UnitControlCount[] | null): string {
  const mut: Record<string, string> = {
    "oracles.test.ts": "C1 by hand: neutering the Oracles' verdict fails 20 of 28 (the other 8 are the clean twins)",
    "faults.test.ts": "C1: pins the Fault driver's contract (kills what it says, never harness connections); C2 added one `appName`-scoping test",
    "c2.test.ts": "C2 by hand: neutering `startNetworkFault` and the drain wait fails 4 of 9 (4 of the 9 need a reachable Toxiproxy and are skipped without one)",
    "holdOracles.test.ts": "C3 by hand: neutering the two new Oracles fails 4; late-confirm predicate `false` fails 2; `>` instead of `>=` fails 1 (boundary test); neutering Oracle 4's expiry predicate fails 3; accepting any count in exactly-one fails 2",
    "faultScoping.test.ts": "C3: `onlyApplicationName` allow-list scoping",
  };
  const covers: Record<string, string> = {
    "oracles.test.ts": "each of Oracles 1–4 against a hand-corrupted scratch DB (double-booked seat, torn/extra/missing-seat Booking, duplicated/replaced/vanished key, held seat with no Hold, expired-never-reaped Hold, leaked row lock), each with a clean-state twin",
    "faults.test.ts": "backend-kill driver",
    "c2.test.ts": "stall sampler, drain wait, app-kill driver, and (real Toxiproxy) latency / stall-partition / reset-partition behaviour",
    "holdOracles.test.ts": "late Booking (+ boundary ±1 µs), live Hold with no/two Bookings, half-applied Reaper shapes, Confirm leaving a Hold behind — each with a clean twin",
    "faultScoping.test.ts": "Fault confined to an application_name allow-list",
  };
  if (!counts) return "_Test files not found next to this module; unit-control counts unavailable._";
  const total = sum(counts.map((c) => c.tests));
  return (
    mdTable(
      ["Test file", "Tests", "What it hand-corrupts / pins", "Mutation check / note (recorded by the ticket that ran it; not re-run for this exhibit)"],
      counts.map((c) => [`\`test/chaos/${c.file}\``, String(c.tests), covers[c.file] ?? "—", mut[c.file] ?? "—"]),
    ) +
    `\n\n**${total} unit controls** (counted from the test files). Their pass/fail status was recorded by C1/C2/C3 against the shared Postgres; this ticket did not re-run them (another session was using that database), so they are cited, not re-verified. Mutation checks were done once by hand by those tickets.`
  );
}

function controlViolationDetail(r: ChaosReport): string {
  const v = r.oracles.flatMap((o) => o.violations).find((x) => x.detail);
  return v?.detail?.replace(/seat [0-9a-f-]{36}/, "one seat") ?? "—";
}

function renderEndToEndControls(all: LoadedChaosReport[]): string {
  const sorted = (g: ChaosGroup) => inGroups(all, g).sort((a, b) => a.report.label.localeCompare(b.report.label));
  const row = (x: LoadedChaosReport): string[] => {
    const r = x.report;
    return [
      `\`${r.label}\``,
      r.args.mode ? `${r.args.mode}${r.args.sabotage && r.args.sabotage !== "none" ? ` + sabotage \`${r.args.sabotage}\`` : ""}${(r.args.reaperIntervalMs ?? 0) > 1_000_000 ? " + reaper never ticks" : ""}` : `\`${r.args.strategy}\` × \`${r.args.load}\``,
      `\`${r.args.fault}\``,
      r.args.db ?? "scratch (full schema)",
      oracleVerdicts(r) || failedOracleNames(r),
      r.correctnessViolation ? "**flagged**" : "clean",
      controlViolationDetail(r),
    ];
  };
  const head = ["Run", "Workload", "Fault", "Database", "Oracles 1–4", "Outcome", "What the Oracle found"];
  const c1 = [...sorted("c1-control"), ...sorted("c1-control-real-schema")];
  const c2 = sorted("c2-control");
  const c3 = sorted("c3-control");
  return `${`**C1 — \`naive\` on a scratch DB without \`UNIQUE(seat_id)\`, no Fault, plus the control's control on the real schema**`}\n\n${mdTable(head, c1.map(row))}\n\n**C2 — the same scratch-DB \`naive\` workload under each of the five new Faults (2 reps each)**\n\n${mdTable(head, c2.map(row))}\n\n**C3 — hold-oracle controls**\n\n${mdTable(["Run", "Workload", "Fault", "Failing Oracles"], c3.map((x) => [`\`${x.report.label}\``, row(x)[1]!, `\`${x.report.args.fault}\``, failedOracleNames(x.report)]))}\n\nThe C3 sabotage controls corrupt the scratch database directly (a post-expiry Booking inserted; a second Booking under one confirm key with the idempotency UNIQUE dropped) or configure the reaper never to tick — the only way to make \`pessimistic\` itself violate a Hold guarantee would be to weaken production code, which ADR-0023 forbids. They prove the pipeline (ledger → Oracle → report → exit status), not the strategy.\n\n**Strength caveat (C2's, still true):** in the partition/SIGKILL controls the double claim can come from the post-Fault replay (itself a 60-way race on one seat) rather than from the faulted load. These runs show the pipeline still *detects* under every Fault, not that each Fault is what produced the violation. Oracles 2–4 stayed green in every control, as they should (the corruption is a mutual-exclusion violation only).`;
}

function renderMatrix(rs: ChaosReport[], faults: string[]): string {
  return faults
    .filter((f) => rs.some((r) => r.args.fault === f))
    .map((f) => {
      const fr = rs.filter((r) => r.args.fault === f);
      return `##### ${f}\n\n${mdTable(
        ["mechanism", ...LOADS],
        MECHS.map((m) => [m, ...LOADS.map((l) => matrixCell(fr.filter((r) => r.args.strategy === m && r.args.load === l)))]),
      )}`;
    })
    .join("\n\n");
}

const MATRIX_LEGEND =
  "Cell legend: Oracle-clean runs/total · Fault landed on in-flight transactions · app process crashed (Robustness) · commits no client was told about (`unack`) · longest app transaction open (`tx`) · `LEAK` = transactions that never drained. A `landed 0/n` cell would be vacuous and says so.";

function renderPerMechanism(rs: ChaosReport[]): string {
  return mdTable(
    ["mechanism", "runs", "Oracle-clean", "Fault landed", "app crashed", "client timeouts", "unclassified 5xx", "503 (`retry_exhausted`)", "unack. commits"],
    MECHS.map((m) => {
      const xs = rs.filter((r) => r.args.strategy === m);
      return [
        `\`${m}\``,
        String(xs.length),
        `${xs.filter((r) => !r.correctnessViolation).length}/${xs.length}`,
        `${xs.filter(landed).length}/${xs.length}`,
        `${xs.filter(crashed).length}/${xs.length}`,
        fmtInt(sum(xs.map((r) => r.k6.clientTimeouts ?? 0))),
        fmtInt(sum(xs.map(unclassified5xx))),
        fmtInt(sum(xs.map((r) => tallyOf(r, "503")))),
        fmtInt(sum(xs.map((r) => r.ambiguity?.committedUnacknowledged ?? 0))),
      ];
    }),
  );
}

function renderStallDrain(rs: ChaosReport[], faults: string[]): string {
  return mdTable(
    ["Fault", "runs", "longest app tx", "max row-lock holders", "longest drain after Fault cleared", "txns that never drained", "client timeouts", "unclassified 5xx"],
    faults
      .filter((f) => rs.some((r) => r.args.fault === f))
      .map((f) => {
        const fr = rs.filter((r) => r.args.fault === f);
        const drains = fr.map((r) => r.drain?.drainedAfterMs).filter((d): d is number => typeof d === "number");
        return [
          f,
          String(fr.length),
          fmtSeconds(Math.max(...fr.map((r) => r.stall?.maxOpenTxAgeMs ?? 0))),
          String(Math.max(...fr.map((r) => r.stall?.peakLockHolders ?? 0))),
          drains.length ? fmtSeconds(Math.max(...drains)) : "n/a",
          String(fr.filter((r) => r.drain?.timedOut).length),
          fmtInt(sum(fr.map((r) => r.k6.clientTimeouts ?? 0))),
          fmtInt(sum(fr.map(unclassified5xx))),
        ];
      }),
  );
}

function renderC1Table(rs: LoadedChaosReport[]): string {
  const sorted = [...rs].sort((a, b) => a.report.ranAt.localeCompare(b.report.ranAt));
  return mdTable(
    ["run", "Fault", "kills", "requests", "k6 outcomes (0 = no answer)", "app exits", "swallowed", "Oracles 1–4"],
    sorted.map((x) => {
      const r = x.report;
      const tally = Object.entries(r.k6.statusTally)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      return [`\`${r.label}\``, r.args.fault, String(kills(r)), String(r.requestsIssued ?? "—"), tally, String(r.app.exits.length), String(swallowed(r)), oracleVerdicts(r)];
    }),
  );
}

interface HoldRow {
  name: string;
  rs: ChaosReport[];
}

function holdRows(all: LoadedChaosReport[], variant: "c3-unmodified" | "c3-scaffolded" | "r1-after"): HoldRow[] {
  const rs = reportsOf(inGroups(all, variant));
  const expiry = rs.filter((r) => r.args.mode === "hold-expiry" && (r.args.reaperStallSeats ?? 0) === 0);
  const stall = rs.filter((r) => r.args.mode === "hold-expiry" && (r.args.reaperStallSeats ?? 0) > 0);
  const confirm3 = rs.filter((r) => r.args.mode === "hold-confirm" && r.args.attemptsPerHold !== 1);
  const confirm1 = rs.filter((r) => r.args.mode === "hold-confirm" && r.args.attemptsPerHold === 1);
  return [
    { name: "hold-expiry (confirms + fresh Holds race the reaper)", rs: expiry },
    { name: "hold-expiry + reaper stalled on 3 locked expired seats", rs: stall },
    { name: "hold-confirm, 3 concurrent attempts per Hold", rs: confirm3 },
    { name: "hold-confirm, one-shot (1 attempt per Hold, kill every 10 ms)", rs: confirm1 },
  ].filter((r) => r.rs.length > 0);
}

function renderHoldTable(rows: HoldRow[]): string {
  return mdTable(
    ["group", "runs", "kills", "k6 outcomes (sum)", "app exits", "swallowed", "reaper sweeps killed", "Confirms completed only by retry", "Oracles 1–4 + 2 ext. clean"],
    rows.map(({ name, rs }) => {
      const tally: Record<string, number> = {};
      for (const r of rs) for (const [k, v] of Object.entries(r.k6.statusTally)) tally[k] = (tally[k] ?? 0) + v;
      const t = Object.entries(tally)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([k, v]) => `${k}:${fmtInt(v)}`)
        .join(" ");
      return [
        name,
        String(rs.length),
        fmtInt(sum(rs.map(kills))),
        t,
        String(sum(rs.map((r) => r.app.exits.length))),
        fmtInt(sum(rs.map(swallowed))),
        String(sum(rs.map((r) => r.app.reaperSweepFailures ?? 0))),
        String(sum(rs.map((r) => r.confirmRetry?.createdByRetry ?? 0))),
        `${rs.filter((r) => !r.correctnessViolation).length}/${rs.length}`,
      ];
    }),
  );
}

function renderHoldBaselines(all: LoadedChaosReport[]): string {
  const rs = inGroups(all, "c3-baseline", "c3-reaperstall-nofault");
  return mdTable(
    ["run", "workload", "k6 outcomes", "app exits", "Oracles clean"],
    rs.map((x) => [
      `\`${x.report.label}\``,
      `${x.report.args.mode}${(x.report.args.reaperStallSeats ?? 0) > 0 ? ` + ${x.report.args.reaperStallSeats} locked expired seats (reaper stalled), no Fault` : ", no Fault"}`,
      Object.entries(x.report.k6.statusTally).map(([k, v]) => `${k}:${v}`).join(" "),
      String(x.report.app.exits.length),
      x.report.correctnessViolation ? "**no**" : "yes",
    ]),
  );
}

function renderLongPartition(all: LoadedChaosReport[]): string {
  const rs = inGroups(all, "c2-long").sort((a, b) => Number(!!a.report.args.surviveUncaught) - Number(!!b.report.args.surviveUncaught) || a.report.args.strategy!.localeCompare(b.report.args.strategy!));
  return mdTable(
    ["mechanism", "variant", "partition", "client timeout", "slowest request", "oldest app transaction", "row-lock holders", "outcome at heal", "drained after heal", "Oracles"],
    rs.map((x) => {
      const r = x.report;
      const statuses = Object.entries(r.k6.statusTally).map(([k, v]) => `${v}×${k === "0" ? "no answer" : k}`).join(", ");
      return [
        `\`${r.args.strategy}\``,
        r.args.surviveUncaught ? "scaffolded" : "unmodified",
        fmtSeconds(r.networkFault?.partitionDurationMs ?? 0),
        fmtSeconds(r.args.requestTimeoutMs ?? 0),
        `${fmtInt(r.k6.maxRequestMs)} ms`,
        `${fmtInt(r.stall?.maxOpenTxAgeMs ?? 0)} ms`,
        String(r.stall?.peakLockHolders ?? 0),
        `${statuses}${crashed(r) ? "; app crashed (R1)" : ""}`,
        `${r.drain?.drainedAfterMs ?? "n/a"} ms`,
        oracleVerdicts(r),
      ];
    }),
  );
}


// ---------------------------------------------------------------------------
// R2 (#54): the idle-pool fix, re-measured. Reports labelled `r2-after*` come
// from the code *with* the `pool.on("error")` handler, so they are their own
// group and never counted among the unmodified runs above. A death is
// attributed by the Node "Emitted 'error' event on <X> instance" line the
// crash prints, which the harness records as an error signature.

const diedOn = (r: ChaosReport, emitter: "BoundPool" | "Client"): boolean =>
  Object.keys(r.app.errorSignatures ?? {}).some((k) => k.includes(`Emitted 'error' event on ${emitter} instance`));

function r2AfterMatrix(all: LoadedChaosReport[]) {
  const rs = reportsOf(inGroups(all, "r2-after"));
  const c1 = rs.filter((r) => r.args.fault === "idle-pool-kill");
  const c2 = rs.filter((r) => r.args.fault === "partition-stall");
  return { c1, c2 };
}

function renderR2FixSummary(all: LoadedChaosReport[]): string {
  const { c1, c2 } = r2AfterMatrix(all);
  if (c1.length === 0 && c2.length === 0) return "not yet re-measured";
  const boundPool = c2.filter((r) => diedOn(r, "BoundPool")).length + c1.filter((r) => diedOn(r, "BoundPool")).length;
  return `after the fix ${c1.filter((r) => !crashed(r)).length}/${c1.length} idle-pool-kill runs survived, and ${boundPool} of ${c1.length + c2.length} reruns died on \`BoundPool\` (see section H)`;
}

function renderR2After(all: LoadedChaosReport[]): string {
  const { c1, c2 } = r2AfterMatrix(all);
  if (c1.length === 0 && c2.length === 0) return "_No `r2-after*` reports yet._";
  const before = reportsOf(inGroups(all, "c1-unmodified")).filter((r) => r.args.fault === "idle-pool-kill");
  const oracles = (rs: ChaosReport[]) => `${rs.filter((r) => !r.correctnessViolation).length}/${rs.length}`;
  const c1Rows = [
    ...before.map((r) => ["before (unmodified)", `\`${r.label}\``, String(r.app.exits.length), diedOn(r, "BoundPool") ? "yes" : "no", JSON.stringify(r.replay?.tally ?? {}), String(r.replay?.networkErrors ?? 0), oracles([r])]),
    ...c1.map((r) => ["after (#54)", `\`${r.label}\``, String(r.app.exits.length), diedOn(r, "BoundPool") ? "yes" : "no", JSON.stringify(r.replay?.tally ?? {}), String(r.replay?.networkErrors ?? 0), oracles([r])]),
  ];
  const refs = reportsOf(inGroups(all, "c2-unmodified")).filter((r) => r.args.fault === "partition-stall" && diedOn(r, "BoundPool") && !diedOn(r, "Client"));
  const cellOf = (r: ChaosReport) => `${r.args.strategy} × ${r.args.load}`;
  const cells = [...new Set(refs.map(cellOf))].sort();
  const variants = [...new Set(c2.map((r) => /^r2-after-c2-([a-z]+)-/.exec(r.label)?.[1] ?? "other"))].sort();
  const c2Rows = variants.flatMap((v) =>
    cells.filter((cell) => c2.some((r) => (/^r2-after-c2-([a-z]+)-/.exec(r.label)?.[1] ?? "other") === v && cellOf(r) === cell)).map((cell) => {
      const rs = c2.filter((r) => (/^r2-after-c2-([a-z]+)-/.exec(r.label)?.[1] ?? "other") === v && cellOf(r) === cell);
      return [
        `\`${v}\``,
        cell,
        String(rs.length),
        `${rs.filter(crashed).length}/${rs.length}`,
        String(rs.filter((r) => diedOn(r, "BoundPool")).length),
        String(rs.filter((r) => diedOn(r, "Client")).length),
        oracles(rs),
      ];
    }),
  );
  const parts = [
    `**C1 idle-pool-kill, before and after.** The harness runs the load, then kills every idle pooled backend in one sweep with no request in flight, then replays every Idempotency Key against the same process. After the fix the process stays up (\`exits\` is empty), logs one line per discarded client, and the replay is answered on fresh connections.`,
    mdTable(["", "Report", "App exits", "Died on `BoundPool`", "Replay statuses", "Replay network errors", "Oracles green"], c1Rows),
    `**C2 \`partition-stall\` rerun on the cells that died *only* via \`BoundPool\` in the committed unmodified matrix** (${refs.length} reference runs: ${refs.map((r) => `\`${r.label}\``).join(", ")}). Four variants, 10 reps per cell, all unmodified code (no \`--survive-uncaught\`): \`matrix\` and \`idleonly\` ran with the idle-pool \`pool.on("error")\` listener *alone* (before #53 merged, so a connection torn while checked out still exited the process via R1); \`merged\` and \`mergedidle\` re-ran the same cells on \`main\` with #53 (R1), #55 (R3) and #56 (R4) in. \`matrix\`/\`merged\` use the committed matrix's own partition timing, so a request is usually in flight at the heal; \`idleonly\`/\`mergedidle\` start the partition after the load has drained (\`--partition-start-ms 2500\`), so the heal can only find idle pooled connections.`,
    mdTable(["Variant", "Cell", "Runs", "Process exited", "Died on `BoundPool`", "Died on `Client` (R1)", "Oracles green"], c2Rows),
  ];
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Section E: the R1 fix (#53), before vs after. "Before" is the pre-fix
// unmodified evidence (groups c1/c2/c3-unmodified); "after" is the `r1-after`
// group. Same Faults, same flags, no `--survive-uncaught` in either.

const R1_C2_CELLS: { mech: string; load: string }[] = [
  { mech: "pessimistic", load: "deadlock-pairs" },
  { mech: "naive", load: "hammer-seat" },
  { mech: "pessimistic", load: "hammer-seat" },
  { mech: "naive", load: "deadlock-pairs" },
];

function r1C1Sets(all: LoadedChaosReport[]): { before: ChaosReport[]; after: ChaosReport[] } {
  return {
    before: reportsOf(inGroups(all, "c1-unmodified")).filter((r) => /^unmodified-kill-rep\d+$/.test(r.label)),
    after: reportsOf(inGroups(all, "r1-after")).filter((r) => /^r1-after-rep\d+$/.test(r.label)),
  };
}

function r1C2Cell(rs: ChaosReport[], fault: string, mech: string, load: string): ChaosReport[] {
  return rs.filter((r) => r.args.fault === fault && r.args.strategy === mech && r.args.load === load);
}

function renderR1Section(all: LoadedChaosReport[]): string {
  const after = reportsOf(inGroups(all, "r1-after"));
  if (after.length === 0) return "_No `r1-after-*` reports present._";
  const { before: c1b, after: c1a } = r1C1Sets(all);
  const c1Row = (name: string, rs: ChaosReport[]): string[] => [
    name,
    String(rs.length),
    String(rs.filter(crashed).length),
    `${fmtInt(sum(rs.map((r) => tallyOf(r, "0"))))} of ${fmtInt(sum(rs.map((r) => r.requestsIssued ?? 0)))}`,
    rs.map((r) => tallyOf(r, "0")).join(" / "),
    fmtInt(sum(rs.map((r) => tallyOf(r, "500")))),
    fmtInt(sum(rs.map(kills))),
    `${rs.filter((r) => !r.correctnessViolation).length}/${rs.length}`,
  ];
  const c1 = mdTable(
    ["code", "runs", "runs where the app exited", "requests with no answer (sum)", "no answer per run", "HTTP 500s", "backends killed", "Oracles clean"],
    [c1Row("before: `unmodified-kill-rep1..3`", c1b), c1Row("**after**: `r1-after-rep1..6`", c1a)],
  );

  const c2b = reportsOf(inGroups(all, "c2-unmodified"));
  const c2a = after.filter((r) => r.args.strategy && r.args.fault.startsWith("partition"));
  const c2Rows: string[][] = [];
  for (const fault of ["partition-stall", "partition-reset"]) {
    for (const { mech, load } of R1_C2_CELLS) {
      const b = r1C2Cell(c2b, fault, mech, load);
      const a = r1C2Cell(c2a, fault, mech, load);
      const fmt = (rs: ChaosReport[]) => `${rs.filter(crashed).length}/${rs.length}`;
      c2Rows.push([
        `\`${fault}\``,
        `\`${mech}\` × \`${load}\``,
        fmt(b),
        `**${fmt(a)}**`,
        `${b.filter(landed).length}/${b.length} → ${a.filter(landed).length}/${a.length}`,
        `${fmtInt(sum(b.map((r) => tallyOf(r, "500"))))} → ${fmtInt(sum(a.map((r) => tallyOf(r, "500"))))}`,
        `${a.filter((r) => !r.correctnessViolation).length}/${a.length}`,
      ]);
    }
  }
  const c2 = mdTable(
    ["Fault", "cell (5 reps each)", "crashed before", "crashed **after**", "Fault landed on in-flight tx (before → after)", "HTTP 500s (before → after)", "Oracles clean after"],
    c2Rows,
  );

  const holds = mdTable(
    ["group", "runs", "kills", "k6 outcomes (sum)", "app exits", "swallowed", "reaper sweeps killed", "Confirms completed only by retry", "Oracles 1–4 + 2 ext. clean"],
    [
      ...holdRows(all, "c3-unmodified").map((r) => ({ ...r, name: `before: ${r.name}` })),
      ...holdRows(all, "r1-after").map((r) => ({ ...r, name: `**after**: ${r.name}` })),
    ].map(({ name, rs }) => {
      const tally: Record<string, number> = {};
      for (const r of rs) for (const [k, v] of Object.entries(r.k6.statusTally)) tally[k] = (tally[k] ?? 0) + v;
      const t = Object.entries(tally)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([k, v]) => `${k}:${fmtInt(v)}`)
        .join(" ");
      return [
        name,
        String(rs.length),
        fmtInt(sum(rs.map(kills))),
        t,
        String(sum(rs.map((r) => r.app.exits.length))),
        fmtInt(sum(rs.map(swallowed))),
        String(sum(rs.map((r) => r.app.reaperSweepFailures ?? 0))),
        String(sum(rs.map((r) => r.confirmRetry?.createdByRetry ?? 0))),
        `${rs.filter((r) => !r.correctnessViolation).length}/${rs.length}`,
      ];
    }),
  );

  const stallAfter = c2a.filter((r) => r.args.fault === "partition-stall");
  const stallAnswerless = stallAfter.filter((r) => (r.requestsIssued ?? 0) > 0 && tallyOf(r, "0") === r.requestsIssued).length;
  const afterCrashed = after.filter(crashed).length;
  const afterViolations = after.filter((r) => r.correctnessViolation).length;
  const reaperStall = after.filter((r) => (r.args.reaperStallSeats ?? 0) > 0);
  const reaperAllAvailable = reaperStall.filter((r) => {
    const st = (r as unknown as { seatStatusAtHeal?: Record<string, number> }).seatStatusAtHeal ?? {};
    return Object.keys(st).length > 0 && Object.keys(st).every((k) => k === "available");
  }).length;
  return `Issue #53 (R1) added one hook to \`src/db/pool.ts\` (ADR-0024: a persistent per-connection \`client.on("error")\` attached from \`pool.on("connect")\`, which covers every checkout path including \`pool.query\` and the reaper, plus a no-op \`pool.on("error")\` for the idle path). The runs below are the issue's own before/after reruns of the *unmodified* app (no \`--survive-uncaught\`), labelled \`r1-after-*\` and kept in their own group so nothing in A–D or the findings table below mixes them in. **${after.length} after-runs: the app exited in ${afterCrashed} of them; Correctness violations: ${afterViolations}.**

**E1. C1 backend-kill** (\`pessimistic\` × \`deadlock-pairs\`, 60 pairs = 120 requests, \`--concurrency 60\`).

${c1}

Before the fix the first killed connection ended the process and ~everything behind it went unanswered; after it, every request is answered (a request cut mid-transaction gets an HTTP 500 — R3, not fixed here — and its Idempotency Key is replayed by the harness afterwards, as before). The 500s are the requests that were mid-flight on a killed connection (${fmtInt(sum(c1a.map((r) => tallyOf(r, "500"))))} of them against ${fmtInt(sum(c1a.map(kills)))} backends killed, since a kill that lands between statements or on an idle-in-transaction client may fail no request).

**E2. C2 partition** (\`--base-latency-ms 40 --partition-ms 7000\`, client timeout 5 s, 5 reps per cell; the "landed" column is C2's definition: app transactions were open when the Fault was applied).

${c2}

${stallAnswerless} of ${stallAfter.length} after-run \`partition-stall\` runs still left *every* request unanswered: that is R4 (no timeouts — the partition outlasts the 5 s client timeout), which R1's fix does not touch and which is not an improvement. What changed is that the process survives the heal (0 exits, 0 restarts) instead of crashing when the stalled connections are torn down.

**E3. C3 hold flow** (backend-kill on \`pessimistic\`; the one-shot row is \`--concurrency 100 --attempts-per-hold 1 --kill-interval-ms 10\`, no committed pre-fix run used these exact flags, so it has no "before" row; the earlier hold-confirm rows crashed on the first kill the same way).

${holds}

In the one-shot rows every Confirm that a kill cut was completed exactly once by the key retry (Oracle 3 extension, "a live Hold's retried Confirm yields exactly one Booking"). In the reaper-stall rows (\`--reaper-stall-seats 3\` + backend-kill) the reaper kept sweeping after connections it was using were killed ("reaper sweeps killed" counts its logged, survived failures) and after heal ${reaperAllAvailable} of ${reaperStall.length} runs had every expired seat \`available\` (Oracle 4).

**What did not improve** (measured, not hidden): the HTTP 500 count went *up* — requests that used to vanish with the process now fail individually with an unclassified 500 (R3); \`partition-stall\` still stalls every request for the whole partition (R4); a stalled reaper still blocks Holds/Confirms on its locked seats (R7); and \`partition-reset\` "landed" counts are partial, as before. During development, a first C1 attempt that carried only the per-checkout listener (no \`pool.on("error")\`; not kept as a report) still crashed once in 3 runs, through the idle path: a kill sweep aimed at in-transaction backends lands on a client the request has just released, which is R2's route — so R2's idle-path guard ships in the same change, and ticket #54 keeps its own acceptance criteria (idle-pool-kill rerun, partition-stall heal-only cases, regression test).`;
}

function renderFindings(ev: FindingEvidence, r1After: { crashed: number; total: number }, all: LoadedChaosReport[], r4After: ChaosReport[] = [], r5After: ChaosReport[] = [], r5Before: ChaosReport[] = [], r2Summary = "", r7After: ChaosReport[] = []): string {
  const r1Fixed = r1After.total > 0;
  const r4Fixed = r4After.length > 0;
  const r5Fixed = r5After.length > 0;
  const r7Fixed = r7After.length > 0;
  const r5Stall = (rs: ChaosReport[]) => rs.filter((r) => r.args.fault === "partition-stall");
  const r5Any500 = (rs: ChaosReport[]) => rs.filter((r) => tallyOf(r, "500") > 0 || replay500(r) > 0).length;
  const head = ["", "Finding", "Class", "Earlier numbering", "Evidence recomputed from the reports"];
  const r6 = ev.r6.filter((r) => r.timeouts > 0 || r.r503 > 0);
  const evidence: Record<string, string> = {
    R1: `${r1Fixed ? `**Fixed by #53 (ADR-0024; section E): ${r1After.crashed}/${r1After.total} unmodified runs crashed afterwards.** Before the fix: ` : ""}${ev.r1.crashed}/${ev.r1.unmodifiedFaultRuns} unmodified runs under a connection-tearing Fault crashed (the idle-pool run is under R2; ${ev.r1.byGroup.map((g) => `${g.label}: ${g.crashed}/${g.total}`).join("; ")}); ${ev.r1.clientEvent} died on an unhandled \`Client\` event. \`pool.on("error")\` alone would not fix it: pg-pool removes its listener on checkout (\`pg-pool/index.js:344\`; C1 read the source) — the fix is a per-connection \`client.on("error")\` attached from \`pool.on("connect")\`, plus a \`pool.on("error")\` for the idle path`,
    R2: `Idle-pool kill, no request in flight: ${ev.r2.crashed}/${ev.r2.idlePoolRuns} crashed on \`BoundPool\`. ${ev.r2.partitionStallBoundPoolOnly} \`partition-stall\` runs died *only* via \`BoundPool\` (the heal found nothing but idle pooled connections). C3 did not re-test${r2Summary ? `. **Fix ticket [#54](https://github.com/pradhnyesh01/RaceToSeat/issues/54)**: ${r2Summary}` : ""}`,
    R3: `On scaffolded runs ${fmtInt(ev.r3.scaffoldedClientVisible500)} requests were answered an unclassified HTTP 500 to clients, and the app logged ${fmtInt(ev.r3.scaffoldedLoggedDeadConnectionErrors)} dead-connection errors — more than clients saw, because ${fmtInt(ev.r3.scaffoldedStallLogged)} of them were logged during scaffolded \`partition-stall\` runs, where clients had already timed out and saw ${fmtInt(ev.r3.scaffoldedStallClientVisible500)} 5xx. The top frame of the logged error is the catch-block \`ROLLBACK\`/\`BEGIN\` on the dead client (\`pool.ts:47\`/\`:134\`/\`:181\`/\`:187\`/\`:41\`) — **not derivable from the JSON** (see Record consistency check). **Fix ticket [#55](https://github.com/pradhnyesh01/RaceToSeat/issues/55)** (ADR-0025): ${renderR3FixSummary(all)}`,
    R4: `${r4Fixed ? `**Fixed by #56 (ADR-0026; section G): after the fix ${r4After.filter((r) => r.label.startsWith("r4-after-partition-stall-") && outlived(r)).length}/${r4After.filter((r) => r.label.startsWith("r4-after-partition-stall-")).length} short-partition runs flagged a transaction outliving the client timeout, and a 30 s partition ended every transaction in ${fmtInt(maxOf(r4After.filter((r) => LONG_AFTER_LABEL.test(r.label)).map((r) => r.stall?.maxOpenTxAgeMs ?? 0)))} ms at most.** Before the fix: ` : ""}${ev.r4.outlived}/${ev.r4.partitionStallRuns} partition-stall runs flagged a transaction outliving the client timeout; longest app transaction ${fmtSeconds(ev.r4.longestTxMsStall)} under a 7 s partition and ${fmtSeconds(ev.r4.longestTxMsLong)} under a 30 s one; ${ev.r4.leaked} transactions leaked after heal in the 420-run matrix (longest drain ${ev.r4.longestDrainMs} ms). Server settings in every report: \`statement_timeout\`, \`lock_timeout\`, \`idle_in_transaction_session_timeout\`, \`idle_session_timeout\` all 0`,
    R5: `${r5Fixed ? `**Fixed by #58 (ADR-0027; section I): the deterministic interleaving now answers the loser 409 (was 500) with no booking row left; ${r5Any500(r5Stall(r5After))} of ${r5Stall(r5After).length} \`partition-stall\` reruns and ${r5Any500(r5After.filter((r) => r.args.fault === "none"))} of ${r5After.filter((r) => r.args.fault === "none").length} no-Fault reruns answered any 500 (code without the fix: ${r5Any500(r5Stall(r5Before))} of ${r5Stall(r5Before).length} and ${r5Any500(r5Before.filter((r) => r.args.fault === "none"))} of ${r5Before.filter((r) => r.args.fault === "none").length} — the rare race did not show up on either build, so the deterministic interleaving is the evidence, not these zeros); all four Oracles green in ${r5After.filter((r) => !r.correctnessViolation).length} of ${r5After.length}.** As found: ` : ""}${ev.r5.matrixHits.length} of ${ev.r5.matrixRuns} matrix runs logged the \`booking_seats_seat_id_key\` violation behind an HTTP 500 (${ev.r5.matrixHits.map((l) => `\`${l}\``).join(", ") || "none"}); ${ev.r5.noFault500} of ${ev.r5.noFaultRuns} dedicated no-Fault advisory reruns answered a 500. Deterministic repro: \`load-harness/chaos/repro-advisory-snapshot-race.ts\` (a \`pg_sleep\` widens the window${r5Fixed ? "; re-run before and after the fix in section I" : "; not re-run here"}). Oracles stayed green: the UNIQUE backstop held`,
    R6: `At 100 ms/chunk (below the 5 s timeout) ${r6.map((r) => `\`${r.mech}\` × \`${r.load}\` timed out ${r.timeouts}/${r.of}${r.r503 ? ` and answered ${r.r503}× 503` : ""}`).join("; ")}; every other cell: 0 timeouts`,
    R7: `${r7Fixed ? `**Fixed by #57 (ADR-0028; section J): ${renderR7FixSummary(r7After)}** As found: ` : ""}Reaper stalled on 3 row-locked expired seats, no Fault: ${ev.r7.controlFreshHoldWins} of 12 fresh Hold attempts won (baseline ${ev.r7.baselineFreshHoldWins} of 12), ${ev.r7.control409}×409 (baseline ${ev.r7.baseline409}). Under backend-kill ${ev.r7.sweepsKilledUnmodified + ev.r7.sweepsKilledScaffolded} reaper sweeps were killed mid-flight (${ev.r7.sweepsKilledUnmodified} unmodified, ${ev.r7.sweepsKilledScaffolded} scaffolded); all seats were reaped after heal. The "blocked sweep leaves NOWAIT on 5 other expired seats failing with 55P03" probe was verified directly by C3, not recorded in a report`,
  };
  return mdTable(
    head,
    CANONICAL_FINDINGS.map((f) => [
      f.id === "R1" && r1Fixed ? "[R1](https://github.com/pradhnyesh01/RaceToSeat/issues/53) (fixed)" : f.id === "R4" ? `[R4](https://github.com/pradhnyesh01/RaceToSeat/issues/56)${r4Fixed ? " (fixed)" : ""}` : f.id === "R5" ? `[R5](https://github.com/pradhnyesh01/RaceToSeat/issues/58)${r5Fixed ? " (fixed)" : ""}` : f.id === "R7" ? `[R7](https://github.com/pradhnyesh01/RaceToSeat/issues/57)${r7Fixed ? " (fixed)" : ""}` : f.id,
      f.title,
      f.klass,
      f.oldNumbers,
      evidence[f.id] ?? "—",
    ]),
  );
}

function renderFormalFindings(): string {
  return mdTable(
    ["", "Finding", "Class", "Evidence (TLC counterexample; cited from `formal/README.md`, not recomputed)", "Why no chaos run could see it"],
    FORMAL_FINDINGS.map((f) => [f.id, f.title, f.klass, f.evidence, f.whyChaosMissesIt]),
  );
}

function renderClaims(rows: ClaimRow[]): string {
  const diffs = rows.filter((r) => !r.match);
  return `${rows.length} numbers quoted by the three findings records were re-derived from the JSON: **${rows.length - diffs.length} match, ${diffs.length} differ**.\n\n${mdTable(
    ["Record", "Claim", "Record says", "Recomputed", ""],
    rows.map((r) => [r.source, r.claim, r.quoted, r.computed, r.match ? "✓" : "**DIFF**"]),
  )}`;
}

// ---------------------------------------------------------------------------
// Section G: the R4 fix (#56), before vs after. "Before" is the committed
// pre-fix evidence (groups c2-long / c2-unmodified / c2-scaffolded); "after" is
// the `r4-after` group, unmodified code (no `--survive-uncaught`), which holds
// the timeouts of ADR-0026. Same Fault, same flags in both.

// One row of the no-regression check: a no-Fault `hammer-seat` run of one
// mechanism, read from `docs/evidence/chaos/r4-nofault/*.json` (the ordinary
// `npm run harness` reports, kept out of docs/evidence/ itself so Exhibit C's
// most-recent-report-wins aggregation never picks them up) next to Exhibit C's
// committed cell for the same mechanism and concurrency.
export interface NoRegressionRow {
  strategy: string;
  concurrency: number;
  repeats: number;
  requests: number;
  p50Ms: number;
  p99Ms: number;
  throughputRps: number;
  tally: Record<string, number>;
  doubleBooked: boolean;
  exhibitC?: { p99Ms: number; throughputRps: number; file: string };
}

const LONG_AFTER_LABEL = /^r4-after-(naive|unique_constraint|pessimistic|optimistic|advisory|serializable)$/;

function stallCell(r: ChaosReport): boolean {
  return r.args.fault === "partition-stall" && r.args.requestTimeoutMs === 5000;
}

function outlived(r: ChaosReport): boolean {
  return r.robustnessObservations.some((o) => o.id === "transaction-outlived-client-timeout");
}

const maxOf = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);

function renderR4Long(all: LoadedChaosReport[], afterReports: ChaosReport[]): string {
  const before = reportsOf(inGroups(all, "c2-long")).filter((r) => !r.args.surviveUncaught);
  const after = afterReports.filter((r) => LONG_AFTER_LABEL.test(r.label));
  const rows: string[][] = [];
  for (const mech of ["pessimistic", "advisory", "serializable"]) {
    for (const [variant, rs] of [["before (`c2long-*`)", before], ["**after (#56)**", after]] as const) {
      const r = rs.find((x) => x.args.strategy === mech);
      if (!r) continue;
      const statuses = Object.entries(r.k6.statusTally).map(([k, v]) => `${v}×${k === "0" ? "no answer" : k}`).join(", ");
      rows.push([
        `\`${mech}\``,
        variant,
        `${fmtInt(r.k6.maxRequestMs)} ms`,
        `${fmtInt(r.stall?.maxOpenTxAgeMs ?? 0)} ms`,
        String(r.stall?.peakLockHolders ?? 0),
        `${statuses}${crashed(r) ? "; app crashed (R1)" : ""}`,
        `${r.drain?.drainedAfterMs ?? "n/a"} ms`,
        oracleVerdicts(r),
      ]);
    }
  }
  return mdTable(["mechanism", "variant", "slowest request", "oldest app transaction", "peak row-lock holders", "outcomes", "drained after heal", "Oracles"], rows);
}

function renderR4Short(all: LoadedChaosReport[], afterReports: ChaosReport[]): string {
  const beforeUnmod = reportsOf(inGroups(all, "c2-unmodified")).filter(stallCell);
  const beforeScaf = reportsOf(inGroups(all, "c2-scaffolded")).filter(stallCell);
  const after = afterReports.filter((r) => r.label.startsWith("r4-after-partition-stall-"));
  const row = (name: string, variant: string, rs: ChaosReport[]): string[] => [
    name,
    variant,
    String(rs.length),
    `${rs.filter(outlived).length}`,
    fmtSeconds(maxOf(rs.map((r) => r.stall?.maxOpenTxAgeMs ?? 0))),
    String(maxOf(rs.map((r) => r.stall?.peakLockHolders ?? 0))),
    fmtSeconds(maxOf(rs.map((r) => r.k6.maxRequestMs))),
    fmtInt(sum(rs.map((r) => r.k6.clientTimeouts ?? 0))),
    `${fmtInt(sum(rs.map((r) => tallyOf(r, "502"))))} / ${fmtInt(sum(rs.map((r) => tallyOf(r, "504"))))} / ${fmtInt(sum(rs.map(unclassified5xx)))} / ${fmtInt(sum(rs.map((r) => tallyOf(r, "0"))))}`,
    `${rs.filter((r) => r.drain?.timedOut).length}`,
    oraclesClean(rs),
  ];
  const rows: string[][] = [];
  for (const mech of MECHS) {
    const mine = (rs: ChaosReport[]) => rs.filter((r) => r.args.strategy === mech);
    rows.push(row(`\`${mech}\``, "before, unmodified", mine(beforeUnmod)));
    rows.push(row("", "before, scaffolded", mine(beforeScaf)));
    rows.push(row("", "**after (#56)**", mine(after)));
  }
  rows.push(row("**all six**", "before, unmodified + scaffolded", [...beforeUnmod, ...beforeScaf]));
  rows.push(row("", "**after (#56)**", after));
  return mdTable(
    ["mechanism", "variant", "runs", "flagged `transaction-outlived-client-timeout`", "longest app tx", "peak lock holders", "slowest request", "client timeouts", "answers 502 / 504 / other 5xx / none", "leaked tx", "Oracles clean"],
    rows,
  );
}

function renderR4NoRegression(rows: NoRegressionRow[]): string {
  if (rows.length === 0) return "_No no-Fault `r4-nofault` reports present._";
  const sorted = [...rows].sort((a, b) => MECHS.indexOf(a.strategy) - MECHS.indexOf(b.strategy) || a.concurrency - b.concurrency);
  return mdTable(
    ["mechanism", "concurrency", "repeats", "requests", "201 / 409 / 503 / other", "double-booked?", "p50 (ms)", "p99 (ms) now", "p99 (ms) Exhibit C", "throughput (req/s) now", "Exhibit C"],
    sorted.map((r) => [
      `\`${r.strategy}\``,
      String(r.concurrency),
      String(r.repeats),
      fmtInt(r.requests),
      `${r.tally["201"] ?? 0} / ${r.tally["409"] ?? 0} / ${r.tally["503"] ?? 0} / **${r.tally.other ?? 0}**`,
      r.doubleBooked ? "**YES**" : "no",
      r.p50Ms.toFixed(1),
      r.p99Ms.toFixed(1),
      r.exhibitC ? r.exhibitC.p99Ms.toFixed(1) : "—",
      r.throughputRps.toFixed(0),
      r.exhibitC ? r.exhibitC.throughputRps.toFixed(0) : "—",
    ]),
  );
}

function renderR4After(all: LoadedChaosReport[], afterReports: ChaosReport[], noRegression: NoRegressionRow[]): string {
  if (afterReports.length === 0) return "_No `r4-after-*` reports present._";
  const shortAfter = afterReports.filter((r) => r.label.startsWith("r4-after-partition-stall-"));
  const longAfter = afterReports.filter((r) => LONG_AFTER_LABEL.test(r.label));
  const beforeShort = [...reportsOf(inGroups(all, "c2-unmodified")), ...reportsOf(inGroups(all, "c2-scaffolded"))].filter(stallCell);
  const violations = afterReports.filter((r) => r.correctnessViolation);
  const mechanisms = uniq(shortAfter.map((r) => r.args.strategy));
  return `Issue #56 (R4) bounded every wait on the database (ADR-0026): server-side \`statement_timeout\` and \`idle_in_transaction_session_timeout\` (1.5 s each, startup parameters on every connection), a client \`query_timeout\` (2 s) paired with destroying the connection when it fires, and \`connectionTimeoutMillis\` (2 s); \`lock_timeout\` is deliberately not set (its \`55P03\` collides with \`NOWAIT\`'s, which the strategies translate to 409). A bound that fires is answered \`504\` with \`outcome: "timeout"\` and the same retry contract as \`502\`. The runs below are the issue's own before/after reruns of the *unmodified* app (no \`--survive-uncaught\`), labelled \`r4-after-*\` and kept in their own group so nothing above mixes them in. **${afterReports.length} after-runs; Correctness violations: ${violations.length}; app exits: ${sum(afterReports.map((r) => r.app.exits.length))}.**

#### G1. Long partition (30 s partition, 60 s client timeout so the client does not give up first)

${renderR4Long(all, afterReports)}

${longAfter.length === 0 ? "" : `Before, a request and its row locks stalled for as long as the partition lasted. After, the slowest request was **${fmtInt(maxOf(longAfter.map((r) => r.k6.maxRequestMs)))} ms** and the oldest app transaction **${fmtInt(maxOf(longAfter.map((r) => r.stall?.maxOpenTxAgeMs ?? 0)))} ms** across the three mechanisms, and every row-lock holder was gone from the stall observer's timeline ~2 s into a 30 s partition — released *during* the partition, not at heal (\`drained after heal\` is a few ms because there was nothing left to drain). The bound is \`statement_timeout\` + \`idle_in_transaction_session_timeout\` = 3 s on the server and \`query_timeout\` = 2 s in the app.`}

#### G2. Short partition (C2 matrix cells: \`partition-stall\` × \`hammer-seat\`/\`deadlock-pairs\` × six mechanisms, 7 s partition, client timeout T = 5 s)

${renderR4Short(all, afterReports)}

Before (unmodified + scaffolded): **${beforeShort.filter(outlived).length} of ${beforeShort.length}** runs flagged a transaction outliving the client's own timeout. After: **${shortAfter.filter(outlived).length} of ${shortAfter.length}** (${mechanisms.length} mechanisms × both loads × 5 reps), longest app transaction ${fmtSeconds(maxOf(shortAfter.map((r) => r.stall?.maxOpenTxAgeMs ?? 0)))}, ${shortAfter.filter((r) => r.drain?.timedOut).length} transactions leaked after heal, Oracle 4 green in ${shortAfter.filter((r) => r.oracles.find((o) => o.oracle === 4)?.passed).length} of ${shortAfter.length}. The "answers" column shows how the requests ended: a \`502\` is the server ending a stalled session (Toxiproxy relays the close to the app, which sees a dead connection), a \`504\` is the app's own bound (\`query_timeout\` / \`connectionTimeoutMillis\`) firing; both carry the "outcome unknown, retry with the same key" contract (ADR-0025/0026). Requests answered "none" are k6's own 5 s client timeout.

#### G3. No regression under normal load (no Fault, \`hammer-seat\`)

${renderR4NoRegression(noRegression)}

\`other\` counts every response that is not 201/409/503, and a \`504\` or \`502\` from a bound firing would land there. **At the acceptance concurrency (100) it is 0 for all six mechanisms, with p99 at or below Exhibit C's committed value for every mechanism** (ranges 25.7–49.1 ms against 43.7–67.8 ms; the committed numbers are one run each from an earlier session, so read "within noise", not "faster"), and the app logged no error line in any of these runs (every fired bound is logged by the error handler). **The nonzero \`other\` at 1,000 concurrent clients is not the bounds firing**: it is k6's own status 0 — connection resets from the load generator exceeding macOS's 128-deep listen backlog (\`kern.ipc.somaxconn\`, see Test environment), the same ceiling that limits every chaos load. Control, same machine and session: \`pessimistic\` and \`naive\` at 1,000 concurrent clients with all four bounds set to 10 minutes (\`docs/evidence/chaos/r4-nofault/unbounded-control/\`) show the same pattern (\`pessimistic\` 420 and 472 \`other\` per run, \`naive\` 304 and 470; with the bounds on, summed over two runs: \`pessimistic\` 548, \`naive\` 944). p99 at 1,000 is higher than Exhibit C's committed numbers for all six mechanisms; it is also higher in the unbounded control (313/90 ms \`pessimistic\`, 308/113 ms \`naive\`), so it is this machine state, not the bounds — but the 1,000-concurrency rows are supplementary and cannot, on this machine, distinguish a bound that rarely fires from none.`;
}

// Section I: the R5 fix (#58, ADR-0027), before vs after. Both variants are
// reruns of the same cells on the *current* code (R1, R3 and R4's fixes
// included) with `advisory.ts` as it was, `r5-before`, and as fixed,
// `r5-after`; "as found" is the C2 matrix's own advisory cell (pre-R4 code).
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const replay500 = (r: ChaosReport): number => r.replay?.tally?.["500"] ?? 0;
const loggedUnique = (r: ChaosReport): boolean =>
  Object.keys(r.app.errorSignatures ?? {}).some((k) => k.includes("booking_seats_seat_id_key") || k.includes("23505"));

function renderR5Row(variant: string, rs: ChaosReport[]): string[] {
  const statuses = ["201", "409", "500", "502", "504", "0"].map((k) => fmtInt(sum(rs.map((r) => tallyOf(r, k)))));
  return [
    variant,
    String(rs.length),
    statuses.join(" / "),
    fmtInt(sum(rs.map(replay500))),
    `${rs.filter((r) => tallyOf(r, "500") > 0 || replay500(r) > 0).length}`,
    `${rs.filter(loggedUnique).length}`,
    fmtInt(sum(rs.map((r) => r.app.exits.length))),
    `${median(rs.map((r) => r.k6.p50RequestMs ?? 0)).toFixed(0)} / ${median(rs.map((r) => r.k6.p95RequestMs ?? 0)).toFixed(0)} / ${fmtInt(maxOf(rs.map((r) => r.k6.maxRequestMs)))}`,
    oraclesClean(rs),
  ];
}

const R5_HEAD = [
  "variant",
  "runs",
  "answers 201 / 409 / 500 / 502 / 504 / none (k6)",
  "500s on the replay",
  "runs answering any 500",
  "runs logging `booking_seats_seat_id_key`",
  "app exits",
  "request ms: median p50 / median p95 / max",
  "Oracles clean",
];

function renderR5NoRegression(nr: { before: NoRegressionRow[]; after: NoRegressionRow[] } | undefined): string {
  if (!nr || (nr.before.length === 0 && nr.after.length === 0)) return "_No `r5-nofault` reports present._";
  const concurrencies = uniq([...nr.before, ...nr.after].map((r) => r.concurrency)).sort((a, b) => a - b);
  const rows: string[][] = [];
  for (const c of concurrencies) {
    for (const [variant, rs] of [["before (#56 code)", nr.before], ["**after (#58)**", nr.after]] as const) {
      // One row per report file (several rounds at one concurrency are shown
      // individually, in the order they ran, so an order effect is visible).
      for (const r of rs.filter((x) => x.concurrency === c)) rows.push([
        String(c),
        variant,
        String(r.repeats),
        fmtInt(r.requests),
        `${r.tally["201"] ?? 0} / ${r.tally["409"] ?? 0} / ${r.tally["503"] ?? 0} / ${r.tally.other ?? 0}`,
        r.doubleBooked ? "**YES**" : "no",
        r.p50Ms.toFixed(1),
        r.p99Ms.toFixed(1),
        r.throughputRps.toFixed(0),
        r.exhibitC ? `${r.exhibitC.p99Ms.toFixed(1)} / ${r.exhibitC.throughputRps.toFixed(0)}` : "—",
      ]);
    }
  }
  return mdTable(
    ["concurrency", "variant", "repeats", "requests", "201 / 409 / 503 / other", "double-booked?", "p50 (ms)", "p99 (ms)", "throughput (req/s)", "Exhibit C p99 / throughput"],
    rows,
  );
}

function renderR5After(
  all: LoadedChaosReport[],
  before: ChaosReport[],
  after: ChaosReport[],
  nr: { before: NoRegressionRow[]; after: NoRegressionRow[] } | undefined,
): string {
  if (after.length === 0) return "_No `r5-after-*` reports present._";
  const stall = (rs: ChaosReport[]) => rs.filter((r) => r.args.fault === "partition-stall");
  const noFault = (rs: ChaosReport[]) => rs.filter((r) => r.args.fault === "none");
  const asFound = reportsOf(inGroups(all, "c2-unmodified")).filter((r) => r.args.strategy === "advisory" && r.args.load === "hammer-seat" && r.args.fault === "partition-stall");
  const asFoundNoFault = reportsOf(inGroups(all, "c2-nofault-advisory"));
  const violations = after.filter((r) => r.correctnessViolation);
  return `Issue #58 (R5) changed \`advisory.ts\` to take the advisory locks in one statement and read \`status\` in a second one, after every lock is held (ADR-0027) — under READ COMMITTED the second statement's snapshot cannot predate a winner whose lock the first statement just acquired. The \`booking_seats\` UNIQUE constraint is not relied on and its violation is deliberately not translated. The runs below are the issue's own before/after reruns of the *unmodified* app (no \`--survive-uncaught\`), labelled \`r5-before-*\` (current code with the old \`advisory.ts\`, ${before.length} runs) and \`r5-after-*\` (with the fix, ${after.length} runs), both on a Postgres and Toxiproxy of their own and kept in groups of their own so no number above mixes them in. **Correctness violations in the after-runs: ${violations.length}; app exits: ${sum(after.map((r) => r.app.exits.length))}.**

#### I1. The deterministic interleaving (\`load-harness/chaos/repro-advisory-snapshot-race.ts\`, Part 2)

Not derivable from the JSON (the script prints, it writes no report). Same interleaving each time — the loser's lock-acquiring statement paused 600 ms between its snapshot and its lock call, a complete winning booking through the real app while it sleeps — run once against the unmodified \`advisory.ts\` and once against the fix:

${mdTable(
  ["", "winner answers", "loser answers", "booking rows left by the loser", "script verdict"],
  [
    ["before (#56 code)", "201", "**500** (\`23505 booking_seats_seat_id_key\` from the loser's \`INSERT INTO booking_seats\`)", "0 (the transaction rolled back)", "FAIL"],
    ["**after (#58)**", "201", "**409**", "0", "PASS"],
  ],
)}

The new Vitest test (\`test/strategies/advisoryStaleSnapshot.test.ts\`) stages the same interleaving; it fails on the unmodified \`advisory.ts\` (\`expected 500 to be 409\`) and passes with the fix. Part 1 of the script (the same race in raw SQL) is unchanged: it demonstrates the window and that the UNIQUE backstop would still refuse the second booking.

#### I2. C2's cell: \`partition-stall\` × \`hammer-seat\` × \`advisory\`, 60 requests, 7 s partition, client timeout 5 s

${mdTable(R5_HEAD, [
  renderR5Row("as found (C2 matrix, pre-R1/R3/R4 code)", asFound),
  renderR5Row("before (#56 code)", stall(before)),
  renderR5Row("**after (#58)**", stall(after)),
])}

**Read the zeros with their caveat.** The before-runs do not show the 500 either, so this cell is no evidence that the fix works: the race is a microseconds-wide window (1 hit in the C2 matrix's 70 advisory runs, found in a *replay* hammer), and under a partition (now ended by ADR-0026's bounds) almost every request is answered 502/504 before it reaches the lock at all. What these 20 reps show is **no regression** — zero 500s, zero app exits, all four Oracles clean, same answers and latency shape — not that R5 is gone. The evidence that it is gone is I1 (the same interleaving, deterministic) and the Vitest test.

#### I3. No Fault: the 20-run advisory hammer (\`c2adv-*\` flags), 60 requests

${mdTable(R5_HEAD, [
  renderR5Row("as found (\`c2adv-*\`, pre-R1/R3/R4 code)", asFoundNoFault),
  renderR5Row("before (#56 code)", noFault(before)),
  renderR5Row("**after (#58)**", noFault(after)),
])}

#### I4. No regression under load (no Fault, \`hammer-seat\`, \`advisory\`)

${renderR5NoRegression(nr)}

**The extra statement costs something measurable at 100 concurrent clients, and the fix does not make \`advisory\` faster anywhere.** In all three before/after pairs at concurrency 100 the fixed build was slower: median p50 +2.5, +2.3 and +0.7 ms over the before-run it was paired with (≈ +3 to +12 %), p99 +3.7, +3.0 and +1.6 ms, throughput −12, −10 and −6 %. The rounds ran in the order before, after (the 5-repeat and 1,000-concurrency pair), then after, before, before, after (the two 10-repeat pairs), so the gap is not an order effect. It is consistent with one extra round trip on every attempt that holds its lock (the winner, and any loser that arrives after the winner's commit; a loser that loses the lock call is unchanged). At 1,000 the fixed build happened to look *faster* (p99 176.9 vs 217.4 ms): with 741–805 of 2,000 requests lost to the load generator's own connection resets that row cannot resolve a ~2 ms effect and is not evidence of a speed-up. Zero double-bookings in every run, both builds, both concurrencies — the project's gate.

"Before" and "after" are the same two builds of the app run on this machine's own Postgres (\`docs/evidence/chaos/r5-nofault/{before,after}/\`, ordinary \`npm run harness\` reports kept out of \`docs/evidence/\` so Exhibit C's aggregation never sees them); "Exhibit C" is its one committed run from an earlier session and machine state, so compare before against after, not either against it. The 1,000-concurrency rows' nonzero \`other\` is the load generator's own connection resets against macOS's 128-deep listen backlog (see Test environment), as in section G.`;
}

// ---------------------------------------------------------------------------
// R7 (#57): the reaper's sweep no longer waits on a row-locked expired seat.

function r7Split(after: ChaosReport[]) {
  const controls = after.filter((r) => r.args.expectViolations);
  const measured = after.filter((r) => !r.args.expectViolations);
  return {
    noFault: measured.filter((r) => r.args.fault === "none"),
    underFault: measured.filter((r) => r.args.fault !== "none"),
    controls,
  };
}

function renderR7FixSummary(after: ChaosReport[]): string {
  const { noFault, underFault, controls } = r7Split(after);
  const wins = noFault.map((r) => tallyOf(r, "201"));
  const flagged = controls.filter((r) => r.correctnessViolation).length;
  return `with 3 row-locked expired seats the no-Fault rerun won ${wins.join(", ") || "—"} of 12 fresh Holds (as found 0, baseline 12) and every seat, bait included, ended \`available\`; ${underFault.length} backend-kill reruns on the unmodified app (${fmtInt(sum(underFault.map(kills)))} kills) ended with every seat \`available\`, no \`holds\`/\`hold_seats\` row left, ${underFault.filter((r) => !r.correctnessViolation).length}/${underFault.length} with all Oracles green, ${sum(underFault.map((r) => r.app.exits.length))} app exits; ${flagged}/${controls.length} negative controls still red`;
}

function renderR7After(all: LoadedChaosReport[], after: LoadedChaosReport[]): string {
  if (after.length === 0) return "_No `r7-*` reports present._";
  const { noFault, underFault, controls } = r7Split(after.map((x) => x.report));
  const baseline = reportsOf(inGroups(all, "c3-baseline")).filter((r) => r.args.mode === "hold-expiry");
  const stalled = reportsOf(inGroups(all, "c3-reaperstall-nofault"));
  const status = (r: ChaosReport) => Object.entries(r.k6.statusTally).map(([k, v]) => `${k}:${v}`).join(" ");
  const finalSeats = (r: ChaosReport) => {
    const f = (r as ChaosReport & { finalState?: { seats: Record<string, number>; holdRowsRemaining: number } }).finalState;
    return f ? `${Object.entries(f.seats).map(([k, v]) => `${v} ${k}`).join(", ")}; ${f.holdRowsRemaining} hold row(s) left` : "—";
  };
  const seatsAtHeal = (r: ChaosReport) => {
    const f = (r as ChaosReport & { seatStatusAtHeal?: Record<string, number> }).seatStatusAtHeal;
    return f ? Object.entries(f).map(([k, v]) => `${v} ${k}`).join(", ") : "—";
  };
  const noFaultRow = (name: string, r: ChaosReport): string[] => [
    name,
    `${tallyOf(r, "201")} of ${r.holdsSeeded ?? 12}`,
    String(tallyOf(r, "409")),
    status(r),
    seatsAtHeal(r),
    finalSeats(r),
    r.correctnessViolation ? "**no**" : "yes",
  ];
  const one = (rs: ChaosReport[]) => rs[0];
  const noFaultRows = [
    ...(one(baseline) ? [noFaultRow("baseline (`c3-baseline-hold-expiry-nofault`): no bait seats", one(baseline)!)] : []),
    ...(one(stalled) ? [noFaultRow("**as found** (`c3-control-reaperstall-nofault`): 3 bait seats, sweep waits on them", one(stalled)!)] : []),
    ...noFault.map((r) => noFaultRow(`**after #57** (\`${r.label}\`): 3 bait seats, sweep skips them`, r)),
  ];
  const scaffoldedStall = holdRows(all, "c3-scaffolded").filter((x) => x.name.includes("reaper stalled"));
  const unmodifiedStall = holdRows(all, "c3-unmodified").filter((x) => x.name.includes("reaper stalled"));
  const r1Stall = holdRows(all, "r1-after").filter((x) => x.name.includes("reaper stalled"));
  const faultRows: HoldRow[] = [
    ...scaffoldedStall.map((x) => ({ name: "as found, *scaffolded* (`--survive-uncaught`): reaper stalled on 3 locked expired seats", rs: x.rs })),
    ...unmodifiedStall.map((x) => ({ name: "as found, unmodified: reaper stalled on 3 locked expired seats", rs: x.rs })),
    ...r1Stall.map((x) => ({ name: "after R1 only (`r1-after-*`, unmodified): reaper stalled on 3 locked expired seats", rs: x.rs })),
    ...(underFault.length ? [{ name: "**after #57** (`r7-after-fault-rep*`, unmodified, `--kill-fraction 0.3`): reaper stalled on 3 locked expired seats", rs: underFault }] : []),
  ];
  return `Issue #57 (R7) changed \`runReaperSweep\` (\`src/reaper.ts\`) so the statement never waits on a row lock (ADR-0028): a \`candidates\` CTE takes \`FOR UPDATE OF s SKIP LOCKED\` on the expired \`held\` seats, the \`UPDATE\` keeps its own \`status = 'held' AND held_until < now()\` re-check, and a Hold is reaped only if all of its seats were locked (a skipped seat leaves its whole Hold for the next tick; \`hold_seats\` has a foreign key to \`holds\` with no cascade, so reaping a Hold's seats piecemeal would fail the statement). The reruns below are the issue's own, on the *unmodified* app (no \`--survive-uncaught\`, R1 having landed), on a Postgres of their own, in a group of their own so no number above mixes them in. **Correctness violations in the after-runs: ${after.filter((x) => !x.report.args.expectViolations && x.report.correctnessViolation).length}; app exits: ${sum(after.map((x) => x.report.app.exits.length))}.**

#### J1. No Fault, reaper stalled on 3 row-locked expired seats (\`--reaper-stall-seats 3 --fault none\`)

12 seats are held and expired, the harness row-locks 3 further expired "bait" seats until the load ends, and 5 Confirms + 5 retrying fresh \`POST /holds\` per seat race the reaper for 3.5 s. "Fresh Holds won" counts HTTP 201s (only fresh Holds can answer 201 in this workload).

${mdTable(["run", "fresh Holds won", "409s", "k6 outcomes", "seats at heal (locks cleared)", "end state", "Oracles clean"], noFaultRows)}

#### J2. Under backend-kill (\`--reaper-stall-seats 3 --kill-fraction 0.3\`), same 3 locked expired seats

${renderHoldTable(faultRows)}

**Read the "reaper sweeps killed" column with care.** It counts logged, survived sweep failures. Before #57 a stalled sweep sat blocked for the whole load, in the middle of a statement, so a backend-kill reliably landed on it (7 and 24 sweeps in the as-found rows). After it, the sweep finishes in milliseconds and a random kill almost never catches it: the column falls to ${sum(underFault.map((r) => r.app.reaperSweepFailures ?? 0))}. That is the fix working, but it also means this workload no longer exercises "a reaper sweep killed mid-statement leaves no half-reaped state" — what remains of that evidence is the as-found rows above (single-statement atomicity) and the deterministic test of the half-reaped shapes (\`test/chaos/holdOracles.test.ts\`). Every after-run ended with every seat \`available\` and no \`holds\`/\`hold_seats\` row left (Oracles 1 and 4 and both Hold extensions green).

#### J3. Negative controls re-run against the fixed code

${mdTable(
    ["Run", "Workload", "Failing Oracles"],
    controls
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((r) => [`\`${r.label}\``, `${r.args.mode}${r.args.sabotage && r.args.sabotage !== "none" ? ` + sabotage \`${r.args.sabotage}\`` : ""}${(r.args.reaperIntervalMs ?? 0) > 1_000_000 ? " + reaper never ticks" : ""}`, failedOracleNames(r)]),
  )}

**What the fix does not change.** A seat whose lock outlives the sweep is reaped on the first tick after the lock clears (J1's "end state" column: all 15 seats \`available\`, bait included, no \`holds\`/\`hold_seats\` row left; at heal the three bait seats were already \`available\` and the other 12 held by the fresh Holds that won). A Confirm that arrives at the instant a sweep holds a seat's row lock still answers 409 (O1 in Exhibit G: both statements use \`NOWAIT\` or \`SKIP LOCKED\`, so a brief collision is a conflict, not a wait); what is gone is the *unbounded* version of that, a conflict that lasts as long as someone else's lock does.`;
}

export interface ExhibitHInputs {
  reports: LoadedChaosReport[];
  unitControls: UnitControlCount[] | null;
  // R4 (#56) no-regression rows; see NoRegressionRow. Empty when no r4-nofault reports exist.
  noRegression?: NoRegressionRow[];
  // R5 (#58) no-regression rows: the same advisory no-Fault hammer-seat runs on
  // the code without the fix (`before`) and with it (`after`), same session.
  r5NoRegression?: { before: NoRegressionRow[]; after: NoRegressionRow[] };
}

export function renderExhibitH({ reports: allReports, unitControls, noRegression = [], r5NoRegression }: ExhibitHInputs): string {
  // Everything except section E and the headline's file count describes the
  // pre-fix evidence; the post-fix `r1-after` reruns (issue #53) are kept out
  // of it so no earlier number moves.
  const all = allReports.filter((x) => !["r1-after", "r2-after", "r4-after", "r5-before", "r5-after", "r7-after"].includes(x.group));
  const afterReports = reportsOf(inGroups(allReports, "r1-after"));
  const r4AfterReports = reportsOf(inGroups(allReports, "r4-after"));
  const r5BeforeReports = reportsOf(inGroups(allReports, "r5-before"));
  const r5AfterReports = reportsOf(inGroups(allReports, "r5-after"));
  const r7AfterReports = inGroups(allReports, "r7-after");
  const afterCrashed = afterReports.filter(crashed).length;
  const c2u = reportsOf(inGroups(all, "c2-unmodified"));
  const c2s = reportsOf(inGroups(all, "c2-scaffolded"));
  const c2all = [...c2u, ...c2s];
  const ev = computeFindingEvidence(all);
  const claims = checkRecordClaims(all);
  const c1u = inGroups(all, "c1-unmodified");
  const c1s = inGroups(all, "c1-scaffolded");
  const TEARING = ["backend-kill", "idle-pool-kill", "partition-stall", "partition-reset"];
  const unmodFaultRuns = [...c1u, ...inGroups(all, "c2-unmodified", "c3-unmodified")].filter((x) => TEARING.includes(x.report.args.fault));
  const unmodCrashed = unmodFaultRuns.filter((x) => crashed(x.report));
  const unmodC2PartitionStall = c2u.filter((r) => r.args.fault === "partition-stall");
  const unanswered = unmodC2PartitionStall.filter((r) => (r.requestsIssued ?? 0) > 0 && tallyOf(r, "0") === r.requestsIssued).length;
  const c1Unanswered = c1u.filter((x) => x.report.args.fault === "backend-kill").map((x) => ({ unans: tallyOf(x.report, "0"), of: x.report.requestsIssued ?? 0 }));

  return `# Exhibit H — Phase 6 chaos testing: four DB-state Oracles under injected Faults

Phase 6 deliverable (todo.md, issue #52 / C5, under umbrella #42): evidence that the project's single hard guarantee — no Seat claimed twice, no torn or duplicate Booking, nothing left stuck — survives failure, not just the happy path. It consolidates the three chaos tickets that ran (C1 #44 backend-kill, C2 #49 latency/partition/app-SIGKILL, C3 #50 hold/confirm/reaper) into one document. **C4 (#51, Postgres restart under load) was not run**; it is the stretch item first in the cut order. The formal-proof half of Phase 6 is Exhibit G (F5) and is not covered here, except that the two Robustness findings the formal track's model checking exposed in the real implementation (RF1–RF2) are recorded below, separately from the chaos-observed ones.

Every number below is recomputed from the per-run JSON reports in \`docs/evidence/chaos/\` by \`npm run harness:aggregate -- --exhibit h\` (\`load-harness/exhibitH.ts\`). The prose findings records (\`chaos-c1-tracer-findings.md\`, \`chaos-c2-fault-matrix.md\`, \`chaos-c3-holds-under-fault.md\`) were *checked against* the JSON, not copied; the disagreements are listed under "Record consistency check". Definitions (Fault, Ambiguous outcome, Oracle, Correctness violation, Robustness finding) are in \`CONTEXT.md\`; the reasoning is ADR-0022 (what "correct under chaos" means) and ADR-0023 (negative controls without production toggles).

## Headline

${renderHeadline(all, allReports.length, r5BeforeReports.length)}

**Read the zero with its caveat.** The unmodified application dies on the first torn connection (R1/R2): ${unmodCrashed.length} of ${unmodFaultRuns.length} unmodified runs under a connection-tearing Fault (backend-kill, idle-pool-kill, partition-stall, partition-reset) ended with the process exiting, and in the four C1 unmodified backend-kill runs ${c1Unanswered.map((c) => `${c.unans} of ${c.of}`).join(", ")} requests (respectively) got no answer. In ${unanswered} of ${unmodC2PartitionStall.length} unmodified \`partition-stall\` runs *every* request went unanswered (the partition outlasted the client timeout). So **the unmodified runs mostly judge little**: "all four Oracles pass" is honest there, but largely because almost nothing ran before the process was gone, and the harness's restart plus full key replay then produced a clean state. The meaningful evidence that the Oracles hold *across many Faults and ongoing traffic* is the \`--survive-uncaught\` scaffolded runs — which are reported separately (ADR-0022) and never merged with the unmodified ones. Neither is evidence about a production deployment with a process supervisor: the harness restart is a stand-in for one.

## Method

- **App under test**: \`tsx src/server.ts\` unmodified, as a child process, one mechanism per process (\`BOOKING_STRATEGY\`, ADR-0002). Its \`DATABASE_URL\` points at Toxiproxy where a network Fault is injected, straight at Postgres for backend-kill. The harness's own driver/Oracle connections always go straight to Postgres, so a Fault on the app's path never blinds the checker. **No production code changed in any chaos ticket** (\`src/\`, \`db/schema.sql\` untouched) — the pre-fix evidence. Section E's after-runs are against the code with #53's fix (\`src/db/pool.ts\`).
- **Isolation**: C2 and C3 runs each use a throwaway database (\`racetoseat_chaos_<hex>\`: the real \`db/schema.sql\` applied verbatim, created and dropped within the run), a per-run \`application_name\`, per-run Toxiproxy proxy, and distinct app/proxy port ranges. The backend killer is scoped by database and \`application_name\`. C1's runs used the shared dev database.
- **Loads** (existing k6 scripts, unmodified except for an optional \`REQUEST_TIMEOUT\` env): \`hammer-seat\` (60 clients, one seat), \`deadlock-pairs\` (60 requests = 30 disjoint 2-seat pairs × both orderings in C2; 60 pairs/120 requests in C1), C3's \`hold-expiry\` (12 seats, every Hold already expired, then 5 Confirms + 5 fresh \`POST /holds\` per seat race the reaper) and \`hold-confirm\` (Confirms against live Holds). 60 clients keeps the load generator under macOS's 128-deep listen backlog (see Test environment).
- **Per run**: the Fault is applied; the load drains; the Fault clears; the app is restarted if it crashed (the crash stays on record); **every Idempotency Key is re-sent** (the Ambiguous-outcome recovery path); then the four Oracles run against stored state. A stall observer samples the app's backends every 50 ms (open transactions, row-lock holders, oldest age) and measures how long after the Fault clears every app transaction takes to end ("drain").
- **Repeats**: 5 reps of every C2 cell; C1 and C3 as tabulated. **Two variants, never merged (ADR-0022)**: *unmodified* code, and *scaffolded* runs where \`--survive-uncaught\` preloads an \`uncaughtException\` handler into the app so the first torn connection does not end the run. The scaffold is harness-only (nothing in \`src/\` changes), counts every exception it swallows, and exists solely so *later, independent* findings and the Oracles' behaviour across many kills stay observable.
- **Verdict**: HTTP responses are never evidence (a 500 can sit on a committed transaction; a 201 can describe state a kill never let persist). The verdict is the Oracles' read of stored state.

## Fault matrix

${renderFaultParameters(all)}

Toxiproxy 2.12.0 behaviours the network Faults rest on (probed by C2, not assumed): removing a \`latency\` toxic **flushes** buffered bytes (an in-flight query completes — a lossless slow link); removing a \`timeout\` toxic does **not** resume the session — the proxy tears the stalled connection down, so both ends see it close; \`reset_peer\` resets connections immediately. A real partition that TCP retransmits across would not sever connections at heal, so \`partition-stall\` here is "a partition whose heal severs the connections that lived through it", a harsher heal than a lossless one.

## Oracles

${renderOracleDefinitions()}

## Negative controls — every checker shown failing (ADR-0023)

A clean run is only evidence if the same pipeline demonstrably goes red on a run that should fail. No control touches \`src/\` or \`db/schema.sql\`, and none uses a test-only toggle in production code.

### Unit controls

${renderUnitControls(unitControls)}

### End-to-end controls (computed from the reports)

${renderEndToEndControls(all)}

## Results

All tables in this section are computed from the reports. A ✅ means the Oracles found no Correctness violation in that cell.

### A. Unmodified production code

> These runs record how the code **behaves as shipped**. Because of R1/R2 most of them end with the app process exiting on the first torn connection; the harness then restarts it and replays every key. Read "crash n/n" before reading "✅ n/n".

#### A1. C2 fault matrix — six mechanisms × two loads

${c2u.length} runs; **Correctness violations: ${c2u.filter((r) => r.correctnessViolation).length}**. ${MATRIX_LEGEND}

${renderMatrix(c2u, C2_FAULTS)}

#### A2. Per-mechanism rollup (all five Faults, both loads)

${renderPerMechanism(c2u)}

\`latency-above\` sits behind most of the \`unack\` column: every request times out client-side while its transaction commits, so the Idempotency-Key replay is what resolves it, to exactly one Booking per key (Oracle 3 green in every run).

#### A3. Stall and drain per Fault (R4)

${renderStallDrain(c2u, C2_FAULTS)}

#### A4. C1 — backend-kill vs \`pessimistic\` (\`deadlock-pairs\`)

${renderC1Table(c1u)}

#### A5. C3 — hold → confirm → reaper under backend-kill (\`pessimistic\`)

${renderHoldTable(holdRows(all, "c3-unmodified"))}

### B. With the \`--survive-uncaught\` scaffold (reported separately, never merged with A)

> Here the process survives, requests continue through the Fault, and the Oracles see real work. The swallowed exceptions are exactly the crashes A shows.

#### B1. C2 — the two partition Faults, six mechanisms × two loads

${c2s.length} runs; **Correctness violations: ${c2s.filter((r) => r.correctnessViolation).length}**. The other three Faults were not run scaffolded: latency and app-SIGKILL never crashed the unmodified app, so they need no twin. ${MATRIX_LEGEND}

${renderMatrix(c2s, ["partition-stall", "partition-reset"])}

#### B2. Per-mechanism rollup

${renderPerMechanism(c2s)}

#### B3. Stall and drain per Fault

${renderStallDrain(c2s, ["partition-stall", "partition-reset"])}

#### B4. C1 — scaffolded backend-kill vs \`pessimistic\`

${renderC1Table(c1s)}

#### B5. C3 — scaffolded hold flow

${renderHoldTable(holdRows(all, "c3-scaffolded"))}

### C. Long partition (R4 measured directly; 30 s partition, 60 s client timeout so the client does not give up first)

${renderLongPartition(all)}

A request and its row locks stall for as long as the partition lasts; nothing gives up on its own. The flip side, measured in all ${c2all.length} matrix runs: once the Fault clears, every transaction drained (longest ${ev.r4.longestDrainMs} ms, ${ev.r4.leaked} leaks), because the heal tears the connections down and Postgres rolls the transactions back.

### D. No-Fault baselines (hold flow) and reruns

${renderHoldBaselines(all)}

The 20 dedicated no-Fault advisory reruns (\`c2adv-*\`, R5) and the no-Fault \`naive\` control twin are summarised under R5 and in the controls table.

### E. After the R1 fix (#53): the same Faults against the fixed code

${renderR1Section(allReports)}

### F. After the R3 fix (#55) — masked errors and the unclassified 500

${renderR3After(all)}

**What the logged error names (hand-counted from the app logs, which are git-ignored — not derivable from the JSON).** Run like for like on a throwaway checkout of unmodified \`main\` (C1 command, 6 reps, same scratch database and ports as the "after" reps) and on this change, counting the first \`src/\` frame of every error the global handler logged:

| C1 backend-kill, 6 reps | before (unmodified \`main\`) | after (#55) |
|---|---|---|
| requests answered by the handler (= the 500s / 502s above, from the reports) | 67 × 500 | 84 × 502 |
| top \`src/\` frame is the catch-block \`ROLLBACK\` / \`BEGIN\` (\`pool.ts:47\`, \`:41\`) | **66** of 67 (64 + 2) | **0** of 84 |
| top \`src/\` frame is the statement that failed (\`pessimistic.ts\`, \`idempotency.ts\`) | 1 | 71 |
| top \`src/\` frame is the \`COMMIT\` that failed (\`pool.ts:220\`, outcome unknown) | 0 | 13 |
| logged headline is the kill itself ("terminating connection due to administrator command") | 1 | 18 |
| "ROLLBACK also failed" secondary lines | 0 | 81 |

On the three C2 \`partition-reset\` cells the same count over the 15 after-runs: 768 logged errors (= the 768 × 502), none whose top frame is a catch-block \`ROLLBACK\` (strategy statements, the failed \`COMMIT\`, and — for \`serializable\` — 48 retry \`BEGIN\`s on a connection that had died after a genuine \`40001\`; the \`40001\` is named on the secondary "ROLLBACK also failed" line next to it, and the request is answered 502, not 503, because no retry budget was spent) plus 2 designed \`409\`s whose closing \`ROLLBACK\` failed and which were still answered \`409\`.

### G. After the R4 fix (#56) — timeouts on every database wait

${renderR4After(all, r4AfterReports, noRegression)}

### H. After the R2 fix (#54) — idle pooled connections only

${renderR2After(allReports)}

### I. After the R5 fix (#58) — \`advisory\` reads status only once it holds the lock

${renderR5After(all, r5BeforeReports, r5AfterReports, r5NoRegression)}

### J. After the R7 fix (#57) — the reaper's sweep skips row-locked seats instead of waiting on them

${renderR7After(all, r7AfterReports)}

## Robustness findings — canonical numbering (R1–R7)

C2 and C3 each independently labelled a different finding "R5". This exhibit uses one list; the three earlier records are left as written, with a short pointer note at the top of each mapping their numbers to these. **C2's R5 (advisory) and R6 keep their numbers; C3's R5 (stalled reaper) becomes R7.** None of the seven is a Correctness violation (all four Oracles stayed intact); R1 has since been fixed (#53, section E) and the other six are not, per the measure-first policy; each is filed as its own fix ticket: R1 #53, R2 #54, R3 #55, R4 #56, R5 #58, R6 #59, R7 #57 (drafts in \`docs/phase6-robustness-ticket-drafts.md\`).

${renderFindings(ev, { crashed: afterCrashed, total: afterReports.length }, all, r4AfterReports, r5AfterReports, r5BeforeReports, renderR2FixSummary(allReports), reportsOf(r7AfterReports))}

Notes: **R1/R2** — a per-checkout \`client.on('error')\` is needed; \`pool.on('error')\` covers R2 only. #53's fix ships both (one hook in \`src/db/pool.ts\`), so R2's idle path is guarded too, though #54's own before/after criteria are still open. **R3** also affects \`withSerializableTransaction\` (\`pool.ts:134\`) and \`withDeadlockRetry\` (\`pool.ts:181\`, \`:187\`), not just \`withTransaction\` (\`pool.ts:47\`); the unclassified 500 is the global error handler (\`src/app.ts:10\`). **R5** is not Fault-dependent and rare; Oracle 1 is a statement about stored state and the \`UNIQUE(seat_id)\` constraint (ADR-0008) kept it correct — what failed was the HTTP answer. It is, though, a mechanism leaning on its backstop while its own check is racy, which ADR-0013 says openly about \`serializable\`; ADR-0027 (#58) fixes the race instead of leaning on the backstop for \`advisory\`. **R6** is a design trade-off of ADR-0009/0011/0013 recorded because it is where "below the timeout" is not below it. **R7** needs a leaked or slow lock (R4) to persist indefinitely.

### Formal-derived findings (RF1–RF2) — kept apart from R1–R7

The formal track's crash / ambiguous-commit / idempotent-retry model (F4, #47, merged to \`main\` as 2f47207) exposed two behaviours of the *real* implementation that no chaos run observed. They are numbered **RF1–RF2** so they cannot be mistaken for chaos evidence: nothing in this table is computed from \`docs/evidence/chaos/*.json\`; the evidence is a TLC counterexample, documented in \`formal/README.md\` ("Findings: behavior the model exposes in the real implementation") and cited here. They are Robustness-class: neither fails a chaos Oracle, neither is a Correctness violation, and the "violated on purpose" configs in \`formal/check.sh\` pin them. Not fixed; filed as RF1 #60 and RF2 #61 (drafts in \`docs/phase6-robustness-ticket-drafts.md\`). The formal exhibit (G, F5) will present the model side; this exhibit only records that the two findings exist and why the chaos track could not have found them.

${renderFormalFindings()}

## Record consistency check

${renderClaims(claims)}

**Discrepancies found by hand (not derivable from the JSON):**

- **R3 top-frame counts (C2 record).** The record's table of top frames (\`pool.ts:187\` 2,663×, \`:47\` 1,090×, \`:134\` 1,049×, \`:181\` 301×, \`:41\` 175×) mixes denominators and two of its five numbers do not reproduce. Re-counting the stack traces in the 120 scaffolded C2 app logs (which still exist in the C2 worktree but are **git-ignored and not in the repository**, so this cannot be regenerated from committed evidence): \`:187\` 2,663 ✓, \`:181\` 301 ✓, \`:41\` 175 ✓, but \`:47\` is **1,474** (not 1,090) and \`:134\` is **1,136** (not 1,049), plus 120× \`uniqueConstraint.ts:37\`, 58× \`naive.ts:49\` and 54× \`pool.ts:128\`. Also, the same sentence pairs those frame counts with "3,109 500s on \`partition-reset\`", but the frames total 5,981 across \`partition-reset\` (3,109) *and* \`partition-stall\` (2,872 — inferred to be requests the app answered 500 after the client had already timed out: the clients saw no 5xx on those runs). The qualitative claim (the catch-block \`ROLLBACK\`/\`BEGIN\` on a dead client is the top frame, hiding the original error) is confirmed. C1's 50 of 53 (\`pool.ts:47\`) and C3's 250 of 258 reproduce exactly.
- **C2 "30 \`Reaper sweep failed\` log lines" sits in the app-SIGKILL paragraph** but the lines come from the partition runs (20 \`partition-reset\`, 10 \`partition-stall\` in the matrix, 6 more in the long-partition runs); the app-SIGKILL runs produced none (the killed process cannot log). The point it makes — the reaper's own \`.catch\` survives a dead connection where the request path does not — stands.
- **R5 frequency.** C2 estimates "1 in ~600 same-seat races". The reports support only "${ev.r5.matrixHits.length} in ${ev.r5.matrixRuns} matrix runs" (${ev.r5.matrixHits.length} in the 70 advisory ones; plus 0 in ${ev.r5.noFaultRuns} dedicated reruns); the ~600 denominator (races per run × runs) is not recorded and could not be reproduced, so no rate beyond "rare" is claimed here.
- **Counts that differ only in what they count** (not errors): the C2 record's "420 matrix runs" excludes 20 \`c2adv\`, 4 \`c2long\`, 10 \`c2ctl\` reports; C3's "49 measured" excludes its 3 controls; this exhibit's "${all.filter((x) => !x.report.args.expectViolations).length} measured" includes everything that is not a control.

## Test environment

- **Machine (inferred, not recorded in the reports)**: the reports carry no hardware metadata. The sessions that produced them ran on the development Mac this repository lives on — Apple M4 (\`Mac16,12\`), 10 cores, 16 GB, macOS 27.2.1, Docker Desktop 4.70.0 (engine 29.4.0), Node v25.6.1, k6 v2.2.0 (versions read on this machine while writing the exhibit). Run dates 2026-11-25 (UTC).
- **Postgres**: \`postgres:17\` (17.10, Debian), the compose service \`racetoseat-postgres\` on \`:5433\`, started with \`deadlock_timeout=100ms\` and \`max_connections=600\` (\`docker-compose.yml\`). Server-side timeouts in every report: \`statement_timeout=0\`, \`lock_timeout=0\`, \`idle_in_transaction_session_timeout=0\`, \`idle_session_timeout=0\`, \`tcp_keepalives_idle=7200\`.
- **Toxiproxy**: \`ghcr.io/shopify/toxiproxy:2.12.0\`. C1 used the compose \`chaos\` profile (\`:5434\` → \`postgres:5432\`); C2 ran its own container (\`docker run … --network racetoseat_default -p 5440-5449:5440-5449 -p 8475:8474 … -host=0.0.0.0\`, API \`:8475\`) because the compose service publishes only \`:5434\`/\`:8474\`. C3's backend-kill needs no proxy.
- **App connection settings**: \`pg\` pool \`max\` = \`PG_POOL_MAX\` (default 500; C3 used 100 to be a good neighbour on the shared Postgres), no \`connectionTimeoutMillis\`/\`idleTimeoutMillis\`/\`query_timeout\` in every run before #56 (R4); since #56 (section G) the app carries ADR-0026's four bounds, which are session/pool settings and so do not show up in the server-wide \`serverTimeouts\` the reports record. Client request timeout T = 5 s for C2. \`HOLD_TTL_SECONDS\` = 8 (hold-expiry) / 120 (hold-confirm), \`REAPER_INTERVAL_MS\` = 1000 in C3.
- **Load ceiling**: macOS \`kern.ipc.somaxconn\` is 128 on this machine. Above ~130 simultaneous k6 connections the load generator alone produces connection resets with **no Fault at all** (C1 observed: ≥80 pairs = 160 clients reset; ≤60 pairs clean). Every chaos load is therefore ≤120 concurrent clients (C1: 60 pairs = 120; C2: 60; C3: ≤120) — except C1's as-found first run (150 pairs = 300 requests, over the ceiling; superseded by the 120-client reruns, which agree) — far below the 1,000-concurrent loads of Exhibits A–F. These results say nothing about Faults at that concurrency.

## What this does not show

- **Postgres restart (C4, #51) was not run.** No Fault here takes the *database* down. \`pg_terminate_backend\` kills individual backends; it is not a crash, a failover, or a restart with recovery.
- **Kill and partition semantics are narrow.** \`pg_terminate_backend\` fails fast and severs cleanly; it never produced the *commit-sent-but-response-lost* Ambiguous outcome (C3: no Confirm committed-then-lost in 274 kills). That case was exercised only by the network Faults and app-SIGKILL (C2: ${fmtInt(sum(c2all.map((r) => r.ambiguity?.committedUnacknowledged ?? 0)))} unacknowledged commits across the matrix, all resolved by replay) — and only for Bookings, not for Holds.
- **Toxiproxy's partition heal severs connections.** \`partition-stall\` heals by tearing down the stalled connections; a real partition that TCP retransmits across would let some in-flight statements finish. The lossless slow link is covered only by \`latency-above\`.
- **One load shape per Fault family.** C1: \`deadlock-pairs\` only. C2: \`hammer-seat\` and \`deadlock-pairs\`, 60 clients, one short burst; the k6 client does not retry, so retry-storm behaviour under a Fault is not modelled. No \`spread-seats\` or isolation-pattern run under any Fault.
- **C2's \`hammer-seat\` window is narrow** (losing requests fail in a few ms), so some timed Faults missed it: the "landed" counts in the tables show how many (e.g. \`partition-stall\` ${c2u.filter((r) => r.args.fault === "partition-stall" && landed(r)).length}/${c2u.filter((r) => r.args.fault === "partition-stall").length} unmodified). A "landed 0/n" cell would be vacuous; none occurs, but several are partial.
- **App-SIGKILL is one kill per run**, and the restart (~650 ms) is the harness's, not a supervisor's.
- **The two formal-derived findings (RF1, RF2) are invisible to these runs by construction.** The Oracles read *stored state after the Fault clears* (ADR-0022): a Booking recreated after Cancel under a reused key (RF1) leaves one row, not two, and a spurious 409 on a same-key retry (RF2) is an HTTP answer about a Booking that does exist exactly once — HTTP responses are never evidence here. The chaos loads also never cancel a Booking and replay its key, and never issue a same-key retry that overlaps the original's commit. A clean chaos run therefore says nothing about either; they were found by model checking (F4) and are not reproduced by any run in this exhibit.
- **Holds under Fault: only \`pessimistic\`** (ADR-0017), only backend-kill, only 12–100 Holds per run. \`POST /holds\` retries have no ledger of fresh-hold keys, so there is no "exactly one Hold per key" Oracle yet.
- **Control strength.** The end-to-end controls show the pipeline *detects* a violation under each Fault; for partition/SIGKILL the violation can come from the replay race rather than the faulted load. The C3 controls corrupt the scratch DB directly and prove the pipeline, not \`pessimistic\`.
- **Unmodified vs scaffolded.** Unmodified runs mostly judge little (above); scaffolded runs judge a program that, as shipped, would have crashed. Neither is a production deployment with a process supervisor and timeouts.
- **Unit-control status is cited, not re-run** for this exhibit; their pass/mutation results come from C1/C2/C3.
- **NFR-style numbers are not in scope.** Latency here describes behaviour under injected slowness (R6), not the throughput/p99 comparison of Exhibit C.

## Reproducing

\`\`\`bash
docker compose up -d                                   # Postgres on :5433
docker run -d --name c2-toxiproxy --network racetoseat_default \\
  -p 5440-5449:5440-5449 -p 8475:8474 ghcr.io/shopify/toxiproxy:2.12.0 -host=0.0.0.0
npx tsx load-harness/chaos/matrix.ts --reps 5          # C2 matrix (resumable; ~1 h)
npm run chaos:holds -- --mode hold-expiry --survive-uncaught --kill-fraction 0.3   # C3
npm run chaos -- --survive-uncaught --kill-fraction 0.3                            # C1
# R1 fix reruns (section E), after #53:
npm run chaos -- --concurrency 60 --label r1-after-rep1                            # C1, repeat for rep2..
npx tsx load-harness/chaos/matrix.ts --label-prefix r1-after- --mechanisms pessimistic,naive \\
  --faults partition-stall,partition-reset --survive-faults none --reps 5           # C2 cells
npm run chaos:holds -- --mode hold-confirm --concurrency 100 --attempts-per-hold 1 --kill-interval-ms 10 --label r1-after-hold-confirm-oneshot-rep1
npm run chaos:holds -- --mode hold-expiry --reaper-stall-seats 3 --label r1-after-hold-expiry-reaperstall-rep1
# R4 fix reruns (section G), after #56:
npx tsx load-harness/chaos/run.ts --strategy pessimistic --load deadlock-pairs --fault partition-stall --db scratch \\
  --toxiproxy-api http://localhost:8475 --proxy-port 5440 --app-port 3200 --request-timeout-ms 60000 \\
  --base-latency-ms 40 --partition-ms 30000 --label r4-after-pessimistic                 # + advisory, serializable
npx tsx load-harness/chaos/matrix.ts --label-prefix r4-after- --faults partition-stall --survive-faults none --reps 5
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern hammer-seat --concurrency 100 --repeat 5   # no-regression; move the reports to docs/evidence/chaos/r4-nofault/
# R5 fix reruns (section I), after #58 (before = the same commands on the parent commit):
npx tsx load-harness/chaos/run.ts --strategy advisory --load hammer-seat --concurrency 60 --fault partition-stall --db scratch \\
  --toxiproxy-api http://localhost:8475 --proxy-port 5440 --app-port 3200 --request-timeout-ms 5000 --label r5-after-partition-stall-advisory-hammer-seat-rep1 \\
  --base-latency-ms 40 --partition-ms 7000 --partition-jitter-ms 120                   # x20 reps; the matrix.ts cell, rep > 3
npx tsx load-harness/chaos/run.ts --strategy advisory --load hammer-seat --concurrency 60 --fault none --db scratch \\
  --toxiproxy-api http://localhost:8475 --proxy-port 5441 --app-port 3201 --request-timeout-ms 60000 --label r5-after-nofault-advisory-hammer-rep1   # x20
npx tsx load-harness/chaos/repro-advisory-snapshot-race.ts                              # I1, both parts
BOOKING_STRATEGY=advisory npm run harness -- --pattern hammer-seat --concurrency 1000 --repeat 2   # no-regression; move the reports to docs/evidence/chaos/r5-nofault/{before,after}/
# R7 fix reruns (section J), after #57 (unmodified app, no --survive-uncaught; before = the committed c3-* reports):
npm run chaos:holds -- --mode hold-expiry --reaper-stall-seats 3 --fault none --label r7-after
npm run chaos:holds -- --mode hold-expiry --reaper-stall-seats 3 --kill-fraction 0.3 --label r7-after-fault-rep1   # rep1..rep4
npm run chaos:holds -- --mode hold-expiry --fault none --reaper-interval-ms 3600000 --expect-violations --label r7-negctl-reaper-off
npm run chaos:holds -- --mode hold-expiry --fault none --sabotage late-confirm --expect-violations --label r7-negctl-late-confirm
npm run chaos:holds -- --mode hold-confirm --concurrency 40 --fault none --hold-ttl-seconds 120 --sabotage duplicate-confirm --expect-violations --label r7-negctl-duplicate-confirm
npm run harness:aggregate -- --exhibit h               # this exhibit, from docs/evidence/chaos/*.json
npx vitest run test/chaos                              # the unit controls
\`\`\`

## Next step

Seven chaos-observed (R1–R7) and two formal-derived (RF1–RF2) Robustness findings are filed as fix tickets #53–#61 (drafts in \`docs/phase6-robustness-ticket-drafts.md\`), which satisfies the umbrella's "every Robustness finding is listed with a follow-up issue link". Phase 6 stays open until the formal Exhibit G (F5) lands and the umbrella is closed out.
`;
}
