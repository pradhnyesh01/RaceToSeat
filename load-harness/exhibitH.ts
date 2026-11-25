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
  replay?: { tally: Record<string, number> };
  holdsSeeded?: number;
  confirmRetry?: { createdByRetry: number; tally: Record<string, number> };
  requestsIssued?: number;
  robustnessObservations: { id: string; detail: string }[];
}

export type ChaosGroup =
  | "c1-unmodified"
  | "c1-scaffolded"
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
  | "c3-control";

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
// `negctl-*`.
export function classify(report: ChaosReport): ChaosGroup {
  const l = report.label;
  const survive = !!report.args.surviveUncaught;
  if (report.args.mode) {
    if (report.args.expectViolations) return "c3-control";
    if (report.args.fault === "none") {
      return (report.args.reaperStallSeats ?? 0) > 0 ? "c3-reaperstall-nofault" : "c3-baseline";
    }
    return survive ? "c3-scaffolded" : "c3-unmodified";
  }
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

// 5xx other than 503: 503 is the designed `retry_exhausted` outcome (ADR-0012).
function unclassified5xx(r: ChaosReport): number {
  return sum(
    Object.entries(r.k6.statusTally)
      .filter(([k]) => k.startsWith("5") && k !== "503")
      .map(([, v]) => v),
  );
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

function renderHeadline(all: LoadedChaosReport[]): string {
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
      ["Report files read (`docs/evidence/chaos/*.json`)", `**${fmtInt(all.length)}**`],
      ["Measured runs (every run that is not a negative control)", `**${fmtInt(measured.length)}** — ${fmtInt(withFault.length)} under a Fault (${fmtInt(unmodFault.length)} on unmodified code, ${fmtInt(scaffoldFault.length)} with the \`--survive-uncaught\` scaffold), ${fmtInt(measured.length - withFault.length)} no-Fault baselines/reruns`],
      ["**Correctness violations** in measured runs (any Oracle failing)", `**${violations.length}**${violations.length ? ` (${violations.map((v) => v.report.label).join(", ")})` : ""}`],
      ["Negative controls that went red as required", `**${flagged.length} of ${controls.length}** end-to-end (\`expectViolations\`); the control's control on the real schema stayed green in ${twins.filter((t) => !t.report.correctnessViolation).length} of ${twins.length}`],
      ["Robustness findings (canonical numbering)", `**${CANONICAL_FINDINGS.length}** — R1–R7 below; none fixed, none filed (drafts in \`docs/phase6-robustness-ticket-drafts.md\`)`],
      ["Production code changed by any chaos ticket", "None: `src/` and `db/schema.sql` untouched (measure-first policy, ADR-0022)"],
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

function holdRows(all: LoadedChaosReport[], variant: "c3-unmodified" | "c3-scaffolded"): HoldRow[] {
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

function renderFindings(ev: FindingEvidence): string {
  const head = ["", "Finding", "Class", "Earlier numbering", "Evidence recomputed from the reports"];
  const r6 = ev.r6.filter((r) => r.timeouts > 0 || r.r503 > 0);
  const evidence: Record<string, string> = {
    R1: `${ev.r1.crashed}/${ev.r1.unmodifiedFaultRuns} unmodified runs under a connection-tearing Fault crashed (the idle-pool run is under R2; ${ev.r1.byGroup.map((g) => `${g.label}: ${g.crashed}/${g.total}`).join("; ")}); ${ev.r1.clientEvent} died on an unhandled \`Client\` event. \`pool.on("error")\` alone would not fix it: pg-pool removes its listener on checkout (\`pg-pool/index.js:344\`; C1 read the source, the fix was not tried)`,
    R2: `Idle-pool kill, no request in flight: ${ev.r2.crashed}/${ev.r2.idlePoolRuns} crashed on \`BoundPool\`. ${ev.r2.partitionStallBoundPoolOnly} \`partition-stall\` runs died *only* via \`BoundPool\` (the heal found nothing but idle pooled connections). C3 did not re-test`,
    R3: `On scaffolded runs ${fmtInt(ev.r3.scaffoldedClientVisible500)} requests were answered an unclassified HTTP 500 to clients, and the app logged ${fmtInt(ev.r3.scaffoldedLoggedDeadConnectionErrors)} dead-connection errors — more than clients saw, because ${fmtInt(ev.r3.scaffoldedStallLogged)} of them were logged during scaffolded \`partition-stall\` runs, where clients had already timed out and saw ${fmtInt(ev.r3.scaffoldedStallClientVisible500)} 5xx. The top frame of the logged error is the catch-block \`ROLLBACK\`/\`BEGIN\` on the dead client (\`pool.ts:47\`/\`:134\`/\`:181\`/\`:187\`/\`:41\`) — **not derivable from the JSON** (see Record consistency check)`,
    R4: `${ev.r4.outlived}/${ev.r4.partitionStallRuns} partition-stall runs flagged a transaction outliving the client timeout; longest app transaction ${fmtSeconds(ev.r4.longestTxMsStall)} under a 7 s partition and ${fmtSeconds(ev.r4.longestTxMsLong)} under a 30 s one; ${ev.r4.leaked} transactions leaked after heal in the 420-run matrix (longest drain ${ev.r4.longestDrainMs} ms). Server settings in every report: \`statement_timeout\`, \`lock_timeout\`, \`idle_in_transaction_session_timeout\`, \`idle_session_timeout\` all 0`,
    R5: `${ev.r5.matrixHits.length} of ${ev.r5.matrixRuns} matrix runs logged the \`booking_seats_seat_id_key\` violation behind an HTTP 500 (${ev.r5.matrixHits.map((l) => `\`${l}\``).join(", ") || "none"}); ${ev.r5.noFault500} of ${ev.r5.noFaultRuns} dedicated no-Fault advisory reruns answered a 500. Deterministic repro: \`load-harness/chaos/repro-advisory-snapshot-race.ts\` (a \`pg_sleep\` widens the window; not re-run here). Oracles stayed green: the UNIQUE backstop held`,
    R6: `At 100 ms/chunk (below the 5 s timeout) ${r6.map((r) => `\`${r.mech}\` × \`${r.load}\` timed out ${r.timeouts}/${r.of}${r.r503 ? ` and answered ${r.r503}× 503` : ""}`).join("; ")}; every other cell: 0 timeouts`,
    R7: `Reaper stalled on 3 row-locked expired seats, no Fault: ${ev.r7.controlFreshHoldWins} of 12 fresh Hold attempts won (baseline ${ev.r7.baselineFreshHoldWins} of 12), ${ev.r7.control409}×409 (baseline ${ev.r7.baseline409}). Under backend-kill ${ev.r7.sweepsKilledUnmodified + ev.r7.sweepsKilledScaffolded} reaper sweeps were killed mid-flight (${ev.r7.sweepsKilledUnmodified} unmodified, ${ev.r7.sweepsKilledScaffolded} scaffolded); all seats were reaped after heal. The "blocked sweep leaves NOWAIT on 5 other expired seats failing with 55P03" probe was verified directly by C3, not recorded in a report`,
  };
  return mdTable(
    head,
    CANONICAL_FINDINGS.map((f) => [f.id, f.title, f.klass, f.oldNumbers, evidence[f.id] ?? "—"]),
  );
}

function renderClaims(rows: ClaimRow[]): string {
  const diffs = rows.filter((r) => !r.match);
  return `${rows.length} numbers quoted by the three findings records were re-derived from the JSON: **${rows.length - diffs.length} match, ${diffs.length} differ**.\n\n${mdTable(
    ["Record", "Claim", "Record says", "Recomputed", ""],
    rows.map((r) => [r.source, r.claim, r.quoted, r.computed, r.match ? "✓" : "**DIFF**"]),
  )}`;
}

export interface ExhibitHInputs {
  reports: LoadedChaosReport[];
  unitControls: UnitControlCount[] | null;
}

export function renderExhibitH({ reports: all, unitControls }: ExhibitHInputs): string {
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

Phase 6 deliverable (todo.md, issue #52 / C5, under umbrella #42): evidence that the project's single hard guarantee — no Seat claimed twice, no torn or duplicate Booking, nothing left stuck — survives failure, not just the happy path. It consolidates the three chaos tickets that ran (C1 #44 backend-kill, C2 #49 latency/partition/app-SIGKILL, C3 #50 hold/confirm/reaper) into one document. **C4 (#51, Postgres restart under load) was not run**; it is the stretch item first in the cut order. The formal-proof half of Phase 6 is Exhibit G (F5) and is not covered here.

Every number below is recomputed from the per-run JSON reports in \`docs/evidence/chaos/\` by \`npm run harness:aggregate -- --exhibit h\` (\`load-harness/exhibitH.ts\`). The prose findings records (\`chaos-c1-tracer-findings.md\`, \`chaos-c2-fault-matrix.md\`, \`chaos-c3-holds-under-fault.md\`) were *checked against* the JSON, not copied; the disagreements are listed under "Record consistency check". Definitions (Fault, Ambiguous outcome, Oracle, Correctness violation, Robustness finding) are in \`CONTEXT.md\`; the reasoning is ADR-0022 (what "correct under chaos" means) and ADR-0023 (negative controls without production toggles).

## Headline

${renderHeadline(all)}

**Read the zero with its caveat.** The unmodified application dies on the first torn connection (R1/R2): ${unmodCrashed.length} of ${unmodFaultRuns.length} unmodified runs under a connection-tearing Fault (backend-kill, idle-pool-kill, partition-stall, partition-reset) ended with the process exiting, and in the four C1 unmodified backend-kill runs ${c1Unanswered.map((c) => `${c.unans} of ${c.of}`).join(", ")} requests (respectively) got no answer. In ${unanswered} of ${unmodC2PartitionStall.length} unmodified \`partition-stall\` runs *every* request went unanswered (the partition outlasted the client timeout). So **the unmodified runs mostly judge little**: "all four Oracles pass" is honest there, but largely because almost nothing ran before the process was gone, and the harness's restart plus full key replay then produced a clean state. The meaningful evidence that the Oracles hold *across many Faults and ongoing traffic* is the \`--survive-uncaught\` scaffolded runs — which are reported separately (ADR-0022) and never merged with the unmodified ones. Neither is evidence about a production deployment with a process supervisor: the harness restart is a stand-in for one.

## Method

- **App under test**: \`tsx src/server.ts\` unmodified, as a child process, one mechanism per process (\`BOOKING_STRATEGY\`, ADR-0002). Its \`DATABASE_URL\` points at Toxiproxy where a network Fault is injected, straight at Postgres for backend-kill. The harness's own driver/Oracle connections always go straight to Postgres, so a Fault on the app's path never blinds the checker. **No production code changed in any chaos ticket** (\`src/\`, \`db/schema.sql\` untouched).
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

## Robustness findings — canonical numbering (R1–R7)

C2 and C3 each independently labelled a different finding "R5". This exhibit uses one list; the three earlier records are left as written, with a short pointer note at the top of each mapping their numbers to these. **C2's R5 (advisory) and R6 keep their numbers; C3's R5 (stalled reaper) becomes R7.** None of the seven is a Correctness violation (all four Oracles stayed intact); none is fixed here, per the measure-first policy; each has a ready-to-file ticket draft in \`docs/phase6-robustness-ticket-drafts.md\`. Issue links are not yet filled in because the drafts are awaiting review.

${renderFindings(ev)}

Notes: **R1/R2** — a per-checkout \`client.on('error')\` is needed; \`pool.on('error')\` covers R2 only. **R3** also affects \`withSerializableTransaction\` (\`pool.ts:134\`) and \`withDeadlockRetry\` (\`pool.ts:181\`, \`:187\`), not just \`withTransaction\` (\`pool.ts:47\`); the unclassified 500 is the global error handler (\`src/app.ts:10\`). **R5** is not Fault-dependent and rare; Oracle 1 is a statement about stored state and the \`UNIQUE(seat_id)\` constraint (ADR-0008) kept it correct — what failed was the HTTP answer. It is, though, a mechanism leaning on its backstop while its own check is racy, which ADR-0013 says openly about \`serializable\` and not yet about \`advisory\`. **R6** is a design trade-off of ADR-0009/0011/0013 recorded because it is where "below the timeout" is not below it. **R7** needs a leaked or slow lock (R4) to persist indefinitely.

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
- **App connection settings**: \`pg\` pool \`max\` = \`PG_POOL_MAX\` (default 500; C3 used 100 to be a good neighbour on the shared Postgres), no \`connectionTimeoutMillis\`/\`idleTimeoutMillis\`/\`query_timeout\` (R4). Client request timeout T = 5 s for C2. \`HOLD_TTL_SECONDS\` = 8 (hold-expiry) / 120 (hold-confirm), \`REAPER_INTERVAL_MS\` = 1000 in C3.
- **Load ceiling**: macOS \`kern.ipc.somaxconn\` is 128 on this machine. Above ~130 simultaneous k6 connections the load generator alone produces connection resets with **no Fault at all** (C1 observed: ≥80 pairs = 160 clients reset; ≤60 pairs clean). Every chaos load is therefore ≤120 concurrent clients (C1: 60 pairs = 120; C2: 60; C3: ≤120) — except C1's as-found first run (150 pairs = 300 requests, over the ceiling; superseded by the 120-client reruns, which agree) — far below the 1,000-concurrent loads of Exhibits A–F. These results say nothing about Faults at that concurrency.

## What this does not show

- **Postgres restart (C4, #51) was not run.** No Fault here takes the *database* down. \`pg_terminate_backend\` kills individual backends; it is not a crash, a failover, or a restart with recovery.
- **Kill and partition semantics are narrow.** \`pg_terminate_backend\` fails fast and severs cleanly; it never produced the *commit-sent-but-response-lost* Ambiguous outcome (C3: no Confirm committed-then-lost in 274 kills). That case was exercised only by the network Faults and app-SIGKILL (C2: ${fmtInt(sum(c2all.map((r) => r.ambiguity?.committedUnacknowledged ?? 0)))} unacknowledged commits across the matrix, all resolved by replay) — and only for Bookings, not for Holds.
- **Toxiproxy's partition heal severs connections.** \`partition-stall\` heals by tearing down the stalled connections; a real partition that TCP retransmits across would let some in-flight statements finish. The lossless slow link is covered only by \`latency-above\`.
- **One load shape per Fault family.** C1: \`deadlock-pairs\` only. C2: \`hammer-seat\` and \`deadlock-pairs\`, 60 clients, one short burst; the k6 client does not retry, so retry-storm behaviour under a Fault is not modelled. No \`spread-seats\` or isolation-pattern run under any Fault.
- **C2's \`hammer-seat\` window is narrow** (losing requests fail in a few ms), so some timed Faults missed it: the "landed" counts in the tables show how many (e.g. \`partition-stall\` ${c2u.filter((r) => r.args.fault === "partition-stall" && landed(r)).length}/${c2u.filter((r) => r.args.fault === "partition-stall").length} unmodified). A "landed 0/n" cell would be vacuous; none occurs, but several are partial.
- **App-SIGKILL is one kill per run**, and the restart (~650 ms) is the harness's, not a supervisor's.
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
npm run harness:aggregate -- --exhibit h               # this exhibit, from docs/evidence/chaos/*.json
npx vitest run test/chaos                              # the unit controls
\`\`\`

## Next step

Seven Robustness findings are drafted as fix tickets in \`docs/phase6-robustness-ticket-drafts.md\`, awaiting review before they are filed (the umbrella's "every Robustness finding is listed with a follow-up issue link" closes once they are). Phase 6 stays open until the formal Exhibit G (F5) lands and the umbrella is closed out.
`;
}
