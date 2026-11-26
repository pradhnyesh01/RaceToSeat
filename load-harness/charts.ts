// Phase 8 chart generator (issue #74, W2): `npm run charts` regenerates four committed SVG charts
// from the measurement reports already in the repository, so the writeup's figures are produced
// from data and not drawn by hand.
//
//   1. Throughput and p99 latency by Mechanism and load level   (Exhibit C, docs/evidence/*.json)
//   2. Deadlocks before and after the lock-ordering fix         (Exhibit D, two pinned reports)
//   3. Cross-seat isolation degradation against the 10% limit  (Exhibit E, docs/evidence/*.json)
//   4. Oracle results across the chaos matrix                   (Exhibit H, docs/evidence/chaos/*.json)
//
// This file is the loading half: reports in, `ChartData` out, files written. Drawing is the pure
// function in chartsRender.ts. Selection rules are the exhibits' own (aggregate.ts's loaders are
// reused, not re-derived), so a chart and the table it mirrors cannot read different reports.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolationCell, loadCells, loadIsolationFiles, STRATEGY_ORDER } from "./aggregate.js";
import { loadChaosReports } from "./exhibitH.js";
import {
  CHART_FILES,
  renderCharts,
  type ChartData,
  type ChaosCell,
  type ComparisonPoint,
  type DeadlockData,
  type DeadlockRun,
  type IsolationPoint,
} from "./chartsRender.js";

const EVIDENCE_DIR = new URL("../docs/evidence/", import.meta.url);
const DEFAULT_OUT_DIR = fileURLToPath(new URL("../docs/charts/", import.meta.url));

// Exhibit D cites exactly these two reports for its before/after tables ("Full report: ..."), so
// the chart pins them rather than guessing which of the four naive deadlock-pairs files at that
// scale is "before" and which is "after".
export const DEADLOCK_BEFORE_REPORT = "naive-deadlock-pairs-load-run-2026-08-24T04-05-54-004Z.json";
export const DEADLOCK_AFTER_REPORT = "naive-deadlock-pairs-load-run-2026-08-24T04-09-21-800Z.json";

interface DeadlockReportLike {
  strategy: string;
  pattern: string;
  anyDoubleBooked: boolean;
  runs: { httpStatusTally: { 201: number; 409: number; 503: number; other: number } }[];
}

function isDeadlockReport(value: unknown): value is DeadlockReportLike {
  const v = value as Partial<DeadlockReportLike> | null;
  return (
    !!v &&
    v.pattern === "deadlock-pairs" &&
    typeof v.strategy === "string" &&
    typeof v.anyDoubleBooked === "boolean" &&
    Array.isArray(v.runs) &&
    v.runs.length > 0 &&
    v.runs.every((run) => {
      const t = run?.httpStatusTally;
      return !!t && typeof t[201] === "number" && typeof t[409] === "number" && typeof t[503] === "number" && typeof t.other === "number";
    })
  );
}

async function loadDeadlockReport(file: string): Promise<DeadlockReportLike> {
  const parsed: unknown = JSON.parse(await readFile(new URL(file, EVIDENCE_DIR), "utf8"));
  if (!isDeadlockReport(parsed)) throw new Error(`${file} is not a deadlock-pairs report with a per-run status tally.`);
  return parsed;
}

// Exhibit D counts a deadlock as a 40P01 that reached the client as an unhandled 500, which the
// harness tallies as `other`.
function deadlockRuns(report: DeadlockReportLike): DeadlockRun[] {
  return report.runs.map((run) => ({
    requests: run.httpStatusTally[201] + run.httpStatusTally[409] + run.httpStatusTally[503] + run.httpStatusTally.other,
    deadlocks: run.httpStatusTally.other,
  }));
}

async function loadComparison(): Promise<ComparisonPoint[]> {
  const cells = await loadCells(EVIDENCE_DIR);
  return cells.map((c) => ({
    mechanism: c.strategy,
    pattern: c.pattern,
    concurrency: c.concurrency,
    throughputRps: c.throughputRps,
    p99Ms: c.p99Ms,
  }));
}

async function loadDeadlock(): Promise<DeadlockData> {
  const [before, after] = await Promise.all([loadDeadlockReport(DEADLOCK_BEFORE_REPORT), loadDeadlockReport(DEADLOCK_AFTER_REPORT)]);
  return { before: deadlockRuns(before), after: deadlockRuns(after), anyDoubleBooked: before.anyDoubleBooked || after.anyDoubleBooked };
}

async function loadIsolation(): Promise<IsolationPoint[]> {
  const { matrix } = await loadIsolationFiles(EVIDENCE_DIR);
  return STRATEGY_ORDER.map((strategy) => ({ mechanism: strategy, degradation: buildIsolationCell(strategy, matrix).degradationPct }));
}

async function loadChaos(): Promise<ChaosCell[]> {
  const loaded = await loadChaosReports(new URL("chaos/", EVIDENCE_DIR));
  const byKey = new Map<string, ChaosCell>();
  for (const { report, group } of loaded) {
    // The two Fault matrices of Exhibit H, kept apart as the exhibit keeps them (ADR-0022).
    if (group !== "c2-unmodified" && group !== "c2-scaffolded") continue;
    const mechanism = report.args.strategy;
    if (!mechanism) continue;
    const variant = group === "c2-scaffolded" ? "scaffolded" : "unmodified";
    const key = `${variant}|${mechanism}|${report.args.fault}`;
    const cell = byKey.get(key) ?? { mechanism, fault: report.args.fault, variant, clean: 0, runs: 0, crashed: 0 };
    cell.runs += 1;
    if (!report.correctnessViolation) cell.clean += 1;
    // Exhibit H's own definition of "app crashed".
    if (report.app.exits.length > 0) cell.crashed += 1;
    byKey.set(key, cell);
  }
  return [...byKey.values()];
}

export async function loadChartData(): Promise<ChartData> {
  const [comparison, deadlock, isolation, chaos] = await Promise.all([loadComparison(), loadDeadlock(), loadIsolation(), loadChaos()]);
  if (comparison.length === 0) throw new Error("No Exhibit C matrix reports found under docs/evidence/.");
  if (chaos.length === 0) throw new Error("No Exhibit H chaos reports found under docs/evidence/chaos/.");
  return { comparison, deadlock, isolation, chaos };
}

/** file name -> SVG text, for the four charts, from the committed reports. */
export async function buildCharts(): Promise<Record<string, string>> {
  return renderCharts(await loadChartData());
}

export function parseOutDir(argv: string[]): string {
  const i = argv.indexOf("--out");
  return i !== -1 && argv[i + 1] ? resolve(argv[i + 1]!) : DEFAULT_OUT_DIR;
}

async function main() {
  const outDir = parseOutDir(process.argv.slice(2));
  const charts = await buildCharts();
  await mkdir(outDir, { recursive: true });
  for (const name of Object.values(CHART_FILES)) {
    await writeFile(resolve(outDir, name), charts[name]!);
    console.log(`wrote ${resolve(outDir, name)}`);
  }
}

// Run only when invoked as a script, so tests can import buildCharts without writing files.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
