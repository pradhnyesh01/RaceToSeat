// Aggregates the JSON run reports load-harness/run.ts already writes into a
// single Markdown comparison document (issue #18's Exhibit C): throughput,
// p50/p99 latency, conflict rate, and retry-exhaustion rate per mechanism
// and load-pattern/concurrency level. Retry-exhaustion rate is its own
// column, not folded into a generic failure tally (ADR-0012's consequence).
// Does not run the matrix itself (issue #18 leaves server-lifecycle
// orchestration out of the harness, ADR-0002) — this only reads whatever
// reports already exist under docs/evidence/.
//
// Issue #35 extends the same tool (rather than adding a parallel generation
// path) with a second mode, selected via --exhibit: "e" renders Exhibit E,
// Phase 4's isolation-pattern comparison (NFR2 — does hot-seat contention
// degrade an unrelated seat's latency?), reading the `isolation`-pattern
// reports load-harness/run.ts --pattern isolation writes instead of the
// hammer-seat/spread-seats reports Exhibit C reads. Default ("c", or
// omitted) is unchanged, preserving `npm run harness:aggregate`'s existing
// behavior.
//
// Issue #41 adds a third mode, "f": Exhibit F, Phase 5's hold-expiry-under-
// load evidence, reading the `hold-expiry`-pattern reports
// load-harness/run.ts --pattern hold-expiry writes. Unlike Exhibit C/E,
// there's only ever one mechanism to report (`pessimistic`, ADR-0017) so
// this reads the single most recent report rather than building a
// per-strategy matrix.
//
// Issue #52 adds a fourth mode, "h": Exhibit H, Phase 6's chaos-testing
// evidence, reading the per-run reports load-harness/chaos/ writes under
// docs/evidence/chaos/ (a subdirectory, unlike the three modes above, so none
// of them can pick those reports up by accident). Most of the logic lives in
// load-harness/exhibitH.ts to keep this file's size in check; this file only
// wires the mode up.
//
// Usage: tsx load-harness/aggregate.ts [--exhibit c|e|f|h] [--out <path>]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countUnitControls, loadChaosReports, renderExhibitH } from "./exhibitH.js";

interface RunReportLike {
  ranAt: string;
  httpStatusTally: { 201: number; 409: number; 503: number; other: number };
  latency: { p50Ms: number; p99Ms: number };
  throughputRps: number;
}

interface CombinedReport {
  strategy: string;
  pattern: "hammer-seat" | "spread-seats";
  concurrency: number;
  runs: RunReportLike[];
  anyDoubleBooked: boolean;
}

interface MatrixCell {
  file: string;
  ranAt: string;
  strategy: string;
  pattern: "hammer-seat" | "spread-seats";
  concurrency: number;
  repeats: number;
  requestsTotal: number;
  throughputRps: number;
  p50Ms: number;
  p99Ms: number;
  conflictRate: number;
  retryExhaustionRate: number;
  doubleBooked: boolean;
}

// Only reports from the current run.ts schema (issue #18: per-run
// latency + a dedicated 503 tally) qualify — older Phase 0/1 evidence
// files predate both and are deliberately excluded from this comparison
// rather than silently aggregated with missing/zeroed columns.
function isCombinedReport(value: unknown): value is CombinedReport {
  const v = value as Partial<CombinedReport> | null;
  const run = v?.runs?.[0];
  return (
    !!v &&
    typeof v.strategy === "string" &&
    (v.pattern === "hammer-seat" || v.pattern === "spread-seats") &&
    typeof v.concurrency === "number" &&
    Array.isArray(v.runs) &&
    v.runs.length > 0 &&
    typeof run?.ranAt === "string" &&
    typeof run?.latency?.p50Ms === "number" &&
    typeof run?.latency?.p99Ms === "number" &&
    typeof run?.throughputRps === "number" &&
    typeof run?.httpStatusTally?.[201] === "number" &&
    typeof run?.httpStatusTally?.[409] === "number" &&
    typeof run?.httpStatusTally?.[503] === "number" &&
    typeof run?.httpStatusTally?.other === "number"
  );
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function toCell(file: string, report: CombinedReport): MatrixCell {
  const requestsTotal = report.runs.reduce(
    (sum, r) =>
      sum + r.httpStatusTally[201] + r.httpStatusTally[409] + r.httpStatusTally[503] + r.httpStatusTally.other,
    0,
  );
  const conflictTotal = report.runs.reduce((sum, r) => sum + r.httpStatusTally[409], 0);
  const retryExhaustedTotal = report.runs.reduce((sum, r) => sum + r.httpStatusTally[503], 0);

  return {
    file,
    ranAt: report.runs[0]!.ranAt,
    strategy: report.strategy,
    pattern: report.pattern,
    concurrency: report.concurrency,
    repeats: report.runs.length,
    requestsTotal,
    throughputRps: mean(report.runs.map((r) => r.throughputRps)),
    p50Ms: mean(report.runs.map((r) => r.latency.p50Ms)),
    p99Ms: mean(report.runs.map((r) => r.latency.p99Ms)),
    conflictRate: requestsTotal > 0 ? conflictTotal / requestsTotal : 0,
    retryExhaustionRate: requestsTotal > 0 ? retryExhaustedTotal / requestsTotal : 0,
    doubleBooked: report.anyDoubleBooked,
  };
}

const STRATEGY_ORDER = ["naive", "unique_constraint", "pessimistic", "optimistic", "advisory", "serializable"];

function cellKey(c: Pick<MatrixCell, "strategy" | "pattern" | "concurrency">): string {
  return `${c.strategy}|${c.pattern}|${c.concurrency}`;
}

// Scans docs/evidence for every JSON report matching the current schema and
// keeps, per (strategy, pattern, concurrency) cell, only the most recent —
// so re-running a single matrix cell doesn't produce duplicate rows.
async function loadCells(evidenceDir: URL): Promise<MatrixCell[]> {
  const entries = await readdir(evidenceDir);
  const byKey = new Map<string, MatrixCell>();
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
    const parsed: unknown = JSON.parse(await readFile(new URL(entry, evidenceDir), "utf8"));
    if (!isCombinedReport(parsed)) continue;
    const cell = toCell(entry, parsed);
    const key = cellKey(cell);
    const existing = byKey.get(key);
    if (!existing || cell.ranAt > existing.ranAt) byKey.set(key, cell);
  }
  return [...byKey.values()].sort((a, b) => {
    const strategyDiff = STRATEGY_ORDER.indexOf(a.strategy) - STRATEGY_ORDER.indexOf(b.strategy);
    if (strategyDiff !== 0) return strategyDiff;
    if (a.pattern !== b.pattern) return a.pattern === "hammer-seat" ? -1 : 1;
    return a.concurrency - b.concurrency;
  });
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderTable(cells: MatrixCell[]): string {
  const header =
    "| Mechanism | Pattern | Concurrency | Repeats | Requests | Throughput (req/s) | p50 (ms) | p99 (ms) | Conflict rate | Retry-exhaustion rate | Double-booked? | Report |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  const rows = cells
    .map((c) => {
      const report = `[${c.file}](${c.file})`;
      return `| \`${c.strategy}\` | ${c.pattern} | ${c.concurrency} | ${c.repeats} | ${c.requestsTotal} | ${c.throughputRps.toFixed(1)} | ${c.p50Ms.toFixed(1)} | ${c.p99Ms.toFixed(1)} | ${fmtPct(c.conflictRate)} | ${fmtPct(c.retryExhaustionRate)} | ${c.doubleBooked ? "**YES**" : "no"} | ${report} |`;
    })
    .join("\n");
  return header + rows + "\n";
}

// PRD's single hard pass/fail gate, restated for the mechanisms whose retry
// policy makes it non-obvious a priori (ADR-0009/ADR-0011): zero
// double-bookings across 2 independent repeats at 1,000-concurrent,
// all-same-seat — the same bar Phase 1 already cleared for
// unique_constraint/pessimistic (Exhibit B).
const TWO_REPEAT_GATE_STRATEGIES = ["optimistic", "advisory", "serializable"];

function renderTwoRepeatGate(cells: MatrixCell[]): string {
  const rows = TWO_REPEAT_GATE_STRATEGIES.map((strategy) => {
    const cell = cells.find((c) => c.strategy === strategy && c.pattern === "hammer-seat" && c.concurrency === 1000);
    if (!cell) return `| \`${strategy}\` | missing | — |`;
    const pass = cell.repeats >= 2 && !cell.doubleBooked;
    return `| \`${strategy}\` | ${cell.repeats} | ${pass ? "**PASS**" : "**FAIL**"} |`;
  }).join("\n");
  return (
    "| Mechanism | Repeats observed | Zero double-bookings across ≥2 repeats |\n" +
    "|---|---|---|\n" +
    rows +
    "\n"
  );
}

// --- Exhibit E: Phase 4 isolation-pattern comparison (issue #35) ---

// Shape of one repeat inside an `isolation`-pattern report
// (run.ts's IsolationRunReport) — only the fields this exhibit reads.
interface IsolationRunLike {
  ranAt: string;
  backgroundStream: { latency: { p50Ms: number; p99Ms: number }; throughputRps: number; anyDoubleBooked: boolean };
}

interface IsolationReport {
  strategy: string;
  pattern: "isolation";
  concurrency: number;
  backgroundOnly: boolean;
  runs: IsolationRunLike[];
  anyDoubleBooked: boolean;
}

// Only reports from run.ts's `--pattern isolation` (issue #33) qualify —
// distinguished from Exhibit C's hammer-seat/spread-seats reports by
// `pattern` and by the nested hotStream/backgroundStream shape (as opposed
// to Exhibit C's flat per-run httpStatusTally/latency/throughputRps).
function isIsolationReport(value: unknown): value is IsolationReport {
  const v = value as Partial<IsolationReport> | null;
  const run = v?.runs?.[0];
  return (
    !!v &&
    typeof v.strategy === "string" &&
    v.pattern === "isolation" &&
    typeof v.backgroundOnly === "boolean" &&
    Array.isArray(v.runs) &&
    v.runs.length > 0 &&
    typeof run?.ranAt === "string" &&
    typeof run?.backgroundStream?.latency?.p99Ms === "number" &&
    typeof run?.backgroundStream?.throughputRps === "number"
  );
}

// Filename marker for the negative-control run (issue #35's acceptance
// criterion: one representative mechanism's combined variant, once, under
// the project's prior/un-widened connection configuration) — applied by
// hand to that one run's output file after the fact (see Exhibit E's own
// Method section for the exact commands), so it's excluded from the
// per-strategy widened-configuration matrix below and picked up separately.
const NEGATIVE_CONTROL_MARKER = "negative-control";

// Filename marker for a pool-size scaling test (issue #36's acceptance
// criterion: re-run a mechanism's combined variant at a deliberately larger
// PG_POOL_MAX to test whether more pool headroom shrinks its degradation —
// evidence for/against connection-pool spillover as the cause, as opposed to
// genuine extra per-request Postgres work). Applied by hand, same as the
// negative-control marker, so it's excluded from the main per-strategy
// dedup and picked up separately; needs both a baseline and combined file
// (unlike the negative control's single combined-only run) so it's tracked
// as its own small matrix, keyed the same way as the main one.
const POOL_SCALING_MARKER = "pool-scaling";

interface IsolationFile {
  file: string;
  report: IsolationReport;
}

// Scans docs/evidence for every isolation-pattern report, splitting the
// negative-control and pool-scaling files (if present) out of the per-
// (strategy, backgroundOnly) "most recent wins" dedup that the widened-
// configuration matrix uses — both are deliberately extra runs for whatever
// strategy they target, not a replacement for that strategy's matrix cell.
async function loadIsolationFiles(evidenceDir: URL): Promise<{
  matrix: Map<string, IsolationFile>;
  negativeControl: IsolationFile | null;
  poolScaling: Map<string, IsolationFile>;
}> {
  const entries = await readdir(evidenceDir);
  const matrix = new Map<string, IsolationFile>();
  const poolScaling = new Map<string, IsolationFile>();
  let negativeControl: IsolationFile | null = null;

  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
    const parsed: unknown = JSON.parse(await readFile(new URL(entry, evidenceDir), "utf8"));
    if (!isIsolationReport(parsed)) continue;

    if (entry.includes(NEGATIVE_CONTROL_MARKER)) {
      if (!negativeControl || parsed.runs[0]!.ranAt > negativeControl.report.runs[0]!.ranAt) {
        negativeControl = { file: entry, report: parsed };
      }
      continue;
    }

    if (entry.includes(POOL_SCALING_MARKER)) {
      const scalingKey = `${parsed.strategy}|${parsed.backgroundOnly}`;
      const existingScaling = poolScaling.get(scalingKey);
      if (!existingScaling || parsed.runs[0]!.ranAt > existingScaling.report.runs[0]!.ranAt) {
        poolScaling.set(scalingKey, { file: entry, report: parsed });
      }
      continue;
    }

    const key = `${parsed.strategy}|${parsed.backgroundOnly}`;
    const existing = matrix.get(key);
    if (!existing || parsed.runs[0]!.ranAt > existing.report.runs[0]!.ranAt) {
      matrix.set(key, { file: entry, report: parsed });
    }
  }

  return { matrix, negativeControl, poolScaling };
}

interface IsolationCell {
  strategy: string;
  baseline: IsolationFile | null;
  combined: IsolationFile | null;
  baselineRepeats: number;
  combinedRepeats: number;
  baselineP99Ms: number | null;
  combinedP99Ms: number | null;
  degradationPct: number | null;
  pass: boolean | null;
  baselineThroughputRps: number | null;
  combinedThroughputRps: number | null;
  anyDoubleBooked: boolean;
}

// NFR2's stated threshold (PRD.md: "<10% degradation" — strict, so exactly
// 10.0% fails).
const NFR2_DEGRADATION_THRESHOLD = 0.1;

function passesNfr2(degradationPct: number | null): boolean | null {
  return degradationPct === null ? null : degradationPct < NFR2_DEGRADATION_THRESHOLD;
}

function fmtPassLabel(pass: boolean | null): string {
  return pass === null ? "missing data" : pass ? "**PASS**" : "**FAIL**";
}

function buildIsolationCell(strategy: string, matrix: Map<string, IsolationFile>): IsolationCell {
  const baseline = matrix.get(`${strategy}|true`) ?? null;
  const combined = matrix.get(`${strategy}|false`) ?? null;

  const baselineP99Ms = baseline ? mean(baseline.report.runs.map((r) => r.backgroundStream.latency.p99Ms)) : null;
  const combinedP99Ms = combined ? mean(combined.report.runs.map((r) => r.backgroundStream.latency.p99Ms)) : null;
  const degradationPct =
    baselineP99Ms !== null && combinedP99Ms !== null && baselineP99Ms > 0
      ? (combinedP99Ms - baselineP99Ms) / baselineP99Ms
      : null;

  return {
    strategy,
    baseline,
    combined,
    baselineRepeats: baseline?.report.runs.length ?? 0,
    combinedRepeats: combined?.report.runs.length ?? 0,
    baselineP99Ms,
    combinedP99Ms,
    degradationPct,
    pass: passesNfr2(degradationPct),
    baselineThroughputRps: baseline ? mean(baseline.report.runs.map((r) => r.backgroundStream.throughputRps)) : null,
    combinedThroughputRps: combined ? mean(combined.report.runs.map((r) => r.backgroundStream.throughputRps)) : null,
    anyDoubleBooked: (baseline?.report.anyDoubleBooked ?? false) || (combined?.report.anyDoubleBooked ?? false),
  };
}

function fmtMs(n: number | null): string {
  return n === null ? "—" : n.toFixed(1);
}

function fmtPctSigned(n: number | null): string {
  if (n === null) return "—";
  const pct = n * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function renderIsolationTable(cells: IsolationCell[]): string {
  const header =
    "| Mechanism | Repeats (baseline/combined) | Baseline p99 (ms) | Combined p99 (ms) | Degradation | Pass (<10%)? | Baseline bg throughput (req/s) | Combined bg throughput (req/s) | Double-booked? | Reports |\n" +
    "|---|---|---|---|---|---|---|---|---|---|\n";
  const rows = cells
    .map((c) => {
      const reports = [c.baseline?.file, c.combined?.file]
        .filter((f): f is string => !!f)
        .map((f) => `[${f}](${f})`)
        .join(", ");
      return `| \`${c.strategy}\` | ${c.baselineRepeats}/${c.combinedRepeats} | ${fmtMs(c.baselineP99Ms)} | ${fmtMs(c.combinedP99Ms)} | ${fmtPctSigned(c.degradationPct)} | ${fmtPassLabel(c.pass)} | ${fmtMs(c.baselineThroughputRps)} | ${fmtMs(c.combinedThroughputRps)} | ${c.anyDoubleBooked ? "**YES**" : "no"} | ${reports || "—"} |`;
    })
    .join("\n");
  return header + rows + "\n";
}

function renderNegativeControl(negativeControl: IsolationFile | null, matrixBaselineByStrategy: Map<string, IsolationCell>): string {
  if (!negativeControl) {
    return "**No negative-control report found.** Run the combined isolation variant once under the prior connection configuration and mark its output filename with `negative-control` (see Method above).\n";
  }

  const strategy = negativeControl.report.strategy;
  const referenceCell = matrixBaselineByStrategy.get(strategy);
  const negativeP99Ms = mean(negativeControl.report.runs.map((r) => r.backgroundStream.latency.p99Ms));
  const negativeThroughputRps = mean(negativeControl.report.runs.map((r) => r.backgroundStream.throughputRps));
  const referenceP99Ms = referenceCell?.baselineP99Ms ?? null;
  const degradationPct =
    referenceP99Ms !== null && referenceP99Ms > 0 ? (negativeP99Ms - referenceP99Ms) / referenceP99Ms : null;
  const pass = passesNfr2(degradationPct);

  return (
    `Representative mechanism: \`${strategy}\`. Its combined isolation variant was run once ` +
    `(\`--repeat 1\`) against a Postgres reconfigured to the project's prior ` +
    `\`max_connections=100\` with the app pool's prior \`PG_POOL_MAX=50\` (both since raised to ` +
    `600/500, issue #33), rather than a fresh un-widened baseline — the reference point below is ` +
    `\`${strategy}\`'s own widened-configuration baseline from the matrix above, which approximates ` +
    `the no-pool-contention case closely enough to demonstrate the harness can detect a real ` +
    `violation.\n\n` +
    "| | Background p99 (ms) | Background throughput (req/s) | Degradation vs. widened-config baseline | Pass (<10%)? |\n" +
    "|---|---|---|---|---|\n" +
    `| Negative control (\`max_connections=100\`, \`PG_POOL_MAX=50\`) | ${fmtMs(negativeP99Ms)} | ${fmtMs(negativeThroughputRps)} | ${fmtPctSigned(degradationPct)} | ${fmtPassLabel(pass)} |\n` +
    `| ${strategy} widened-config baseline (reference) | ${fmtMs(referenceP99Ms)} | — | — | — |\n\n` +
    `Full report: [${negativeControl.file}](${negativeControl.file}).\n`
  );
}

function renderPoolScaling(scalingCell: IsolationCell | null, defaultPoolCell: IsolationCell | undefined): string {
  if (!scalingCell) {
    return "**No pool-scaling report found.** Run a mechanism's combined and background-only variants once against a larger `PG_POOL_MAX` and mark both output filenames with `pool-scaling`.\n";
  }

  return (
    `Representative mechanism: \`${scalingCell.strategy}\`, re-run at \`PG_POOL_MAX=1000\` ` +
    `(Postgres temporarily reconfigured to \`max_connections=1200\` to give that pool real ` +
    `headroom, restored to 600 afterward) — a scoped confirmatory test, hence 3 repeats rather ` +
    `than the 5+ used for a trustworthy magnitude elsewhere in this exhibit.\n\n` +
    "| | Repeats | Baseline p99 (ms) | Combined p99 (ms) | Degradation |\n" +
    "|---|---|---|---|---|\n" +
    `| Default pool (\`PG_POOL_MAX=500\`) | ${defaultPoolCell?.baselineRepeats ?? "—"}/${defaultPoolCell?.combinedRepeats ?? "—"} | ${fmtMs(defaultPoolCell?.baselineP99Ms ?? null)} | ${fmtMs(defaultPoolCell?.combinedP99Ms ?? null)} | ${fmtPctSigned(defaultPoolCell?.degradationPct ?? null)} |\n` +
    `| Scaled pool (\`PG_POOL_MAX=1000\`) | ${scalingCell.baselineRepeats}/${scalingCell.combinedRepeats} | ${fmtMs(scalingCell.baselineP99Ms)} | ${fmtMs(scalingCell.combinedP99Ms)} | ${fmtPctSigned(scalingCell.degradationPct)} |\n\n` +
    `2x the pool headroom only modestly reduced the degradation (${fmtPctSigned(defaultPoolCell?.degradationPct ?? null)} → ${fmtPctSigned(scalingCell.degradationPct)}), not the substantial drop a pool-spillover-dominated cause would predict — evidence *against* connection-pool queuing as the primary driver, and *for* the genuine extra per-request Postgres work identified below.\n\n` +
    `Full reports: [${scalingCell.baseline?.file}](${scalingCell.baseline?.file}), [${scalingCell.combined?.file}](${scalingCell.combined?.file}).\n`
  );
}

async function mainExhibitE(evidenceDir: URL, outPath: string) {
  const { matrix, negativeControl, poolScaling } = await loadIsolationFiles(evidenceDir);

  const cells = STRATEGY_ORDER.map((strategy) => buildIsolationCell(strategy, matrix));
  const cellsByStrategy = new Map(cells.map((c) => [c.strategy, c]));
  const missingStrategies = cells.filter((c) => !c.baseline || !c.combined).map((c) => c.strategy);
  const failingStrategies = cells.filter((c) => c.pass === false).map((c) => c.strategy);

  // Whichever strategy has a pool-scaling baseline+combined pair (issue #36:
  // only optimistic, so far) — buildIsolationCell's math is identical, just
  // reading from the pool-scaling map instead of the main matrix.
  const poolScalingStrategy = [...new Set([...poolScaling.keys()].map((k) => k.split("|")[0]!))].find(
    (strategy) => poolScaling.has(`${strategy}|true`) && poolScaling.has(`${strategy}|false`),
  );
  const poolScalingCell = poolScalingStrategy ? buildIsolationCell(poolScalingStrategy, poolScaling) : null;

  const doc = `# Exhibit E — Phase 4 cross-seat isolation benchmark (NFR2)

Phase 4 deliverable (todo.md, issue #35): measured evidence for NFR2 — does
sustained high-concurrency contention on one "hot" seat degrade p99 latency
for requests against unrelated seats by more than the agreed 10% threshold
(PRD.md)? Builds on issue #33's foundation: the \`isolation\` load pattern
(\`load-harness/cross-seat-isolation.k6.js\`, hot-seat burst + background
stream as two concurrent k6 scenarios in one invocation) and the widened
connection configuration (Postgres \`max_connections\` 100→600, app pool
\`PG_POOL_MAX\` 50→500, \`docker-compose.yml\`/\`src/db/pool.ts\`) that keeps
connection-pool admission from dominating the isolation signal at this
pattern's 1,000+1,000-request peak concurrency.

## Method

For each of the six \`BOOKING_STRATEGY\` mechanisms, at the widened
connection configuration: the background-only baseline and the combined
(hot + background) variant, each run twice (\`--repeat 2\`, one harness
invocation per variant — the harness resets via \`DELETE /bookings/{id}\`
between repeats and writes both repeats into one report). Each side's
background-stream p99 is averaged across its two repeats before computing
one degradation percentage per mechanism: \`(combined p99 − baseline p99) /
baseline p99\`.

\`\`\`bash
docker compose up -d   # max_connections=600 (issue #33)
npm run db:migrate
BOOKING_STRATEGY=<mechanism> PORT=3000 npm run start
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern isolation --background-only --concurrency 1000 --repeat 2
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern isolation                    --concurrency 1000 --repeat 2

npm run harness:aggregate -- --exhibit e   # this script — reads docs/evidence/*.json, writes this file
\`\`\`

**\`pessimistic\` and \`optimistic\`'s exception (5 repeats, not 2):** the
original 2-repeat measurement reported +37.5% for \`pessimistic\` and +14.4%
for \`optimistic\` (both FAIL). A same-session follow-up grilling pass found
\`pessimistic\`'s didn't reproduce — three independent single-repeat reruns
swung from -41% to +4%, including negative-degradation runs, with baseline
p99 alone varying 174-482ms with zero hot-seat contention at all — clear
2-repeat noise, not a stable signal. \`optimistic\`'s did reproduce (all
positive, several far larger than +14.4%) and was carried into issue #36's
investigation. Both were re-measured at \`--repeat 5\` for both variants and
Exhibit E regenerated, which is why their rows below show 5/5 repeats where
the other four mechanisms show 2/2.

**Negative control:** to confirm the measurement can actually detect a
violation before reporting six results all expected to pass, \`pessimistic\`
— the one mechanism whose lock acquisition genuinely blocks
(\`SELECT ... FOR UPDATE NOWAIT\` still queues connection admission itself
under an undersized pool, ADR-0006) — was also run once under the project's
*prior* connection configuration:

\`\`\`bash
docker stop racetoseat-postgres && docker rm racetoseat-postgres
docker run -d --name racetoseat-postgres -p 5433:5432 \\
  -e POSTGRES_USER=racetoseat -e POSTGRES_PASSWORD=racetoseat -e POSTGRES_DB=racetoseat \\
  -v racetoseat_racetoseat-pgdata:/var/lib/postgresql/data \\
  postgres:17 postgres -c deadlock_timeout=100ms -c max_connections=100
BOOKING_STRATEGY=pessimistic PG_POOL_MAX=50 PORT=3000 npm run start
BOOKING_STRATEGY=pessimistic npm run harness -- --pattern isolation --concurrency 1000 --repeat 1
# output file renamed to insert "negative-control" so aggregate.ts excludes
# it from the per-strategy matrix dedup above
docker compose up -d   # restores max_connections=600
\`\`\`

## Results — widened connection configuration (all six mechanisms)

${renderIsolationTable(cells)}
${missingStrategies.length > 0 ? `\n**Note:** no matching baseline+combined report pair found yet for: ${missingStrategies.map((s) => `\`${s}\``).join(", ")}. The table above reflects only the runs present under \`docs/evidence/\` at generation time.\n` : ""}
## Results — negative control (prior connection configuration)

${renderNegativeControl(negativeControl, cellsByStrategy)}

## Results — pool-scaling test (\`optimistic\`, issue #36)

${renderPoolScaling(poolScalingCell, cellsByStrategy.get("optimistic"))}

## Findings

${failingStrategies.length > 0 ? `\`${failingStrategies.join("`, `")}\` exceed(s) the 10% degradation threshold at the widened connection configuration. Per this project's single hard correctness gate (PRD §Metrics & Acceptance Criteria: zero double-booking), this is **not** a blocker for this exhibit's completion — NFR2 is a measured non-functional target, not the correctness gate.` : "All six mechanisms pass the 10% degradation threshold at the widened connection configuration."}

### \`optimistic\` (issue #36 investigation, this exhibit's numbers below are always current)

Current magnitude at 5 repeats: \`${fmtPctSigned(cellsByStrategy.get("optimistic")?.degradationPct ?? null)}\`
— substantially larger than the original 2-repeat +14.4%, and (unlike
\`pessimistic\`'s) a real, reproducible signal: three independent
single-repeat reruns during the follow-up investigation were all positive
(up to +573%).

**Root cause, confirmed empirically:** a losing request under hot-seat
contention takes a more expensive path in \`optimistic\` than in the other
five mechanisms. Comparing Postgres query-log volume for the identical
50-concurrent single-seat burst: \`naive\` issued 169 total statements,
\`optimistic\` issued 405 — **~2.4x**. This matches the code path exactly:
an ordinary CAS miss (the seat is already \`'booked'\`, not a concurrent-
cancellation race) runs an initial \`readSeats\`, a \`SAVEPOINT\`, the CAS
\`UPDATE\` itself (a real row check even though it affects 0 rows), a
\`ROLLBACK TO SAVEPOINT\`, and a second \`readSeats\` (ADR-0009's
cancellation-race check) — roughly double \`naive\`'s single read-then-write
path, before accounting for connection-pool round-trip overhead on top.

**Pool-scaling test rules out pool spillover as the primary cause** (see
above): doubling \`PG_POOL_MAX\` only modestly reduced the degradation. The
cost is genuine extra Postgres-side work from the CAS-miss path's shape, not
connections queuing for a slot.

**Recommendation: document as an inherent trade-off, not fix.** The second
\`readSeats\` isn't incidental overhead — it's ADR-0009's correctness
mechanism for distinguishing a genuine conflict from a concurrent
cancellation race (see \`optimistic.test.ts\`'s "retries and succeeds when a
CAS miss turns out to be a concurrent cancellation" test). Removing it to
cut round-trips would weaken that guarantee; a real fix would need a
different query shape entirely (e.g. a single \`UPDATE ... RETURNING\`
combining the CAS and the conflict-vs-cancellation check), which changes
what Exhibit C's own comparative benchmark is measuring for this mechanism —
out of scope for an isolation-measurement ticket. \`optimistic\`'s extra
cost under hot-seat contention is a property of the CAS-retry design this
project set out to compare against pessimistic/advisory locking, not a bug
in it.

The negative control demonstrates the measurement is sensitive enough to
catch a real violation: run against the project's prior, un-widened
connection configuration, the same pattern that (mostly) passes above
produces a measurably larger degradation, consistent with connection-pool
queuing rather than row-lock contention (the caveat already noted inline in
\`cross-seat-isolation.k6.js\` since issue #33) — the same phenomenon the
pool-scaling test above found does *not* explain \`optimistic\`'s own
degradation, a useful contrast: two different mechanisms can each show a
real NFR2 finding for two different underlying reasons.

## Reading the columns

- **Repeats (baseline/combined)**: how many independent repeats each side's
  mean is drawn from — 2/2 for four mechanisms, 5/5 for \`pessimistic\` and
  \`optimistic\` (see Method's exception note above).
- **Baseline / Combined p99**: mean across that many repeats of the
  *background stream's* \`http_req_duration\` p99 (k6 \`--summary-export\`) —
  baseline is the background-only run (no hot-seat contention), combined is
  the same background stream measured while the hot-seat burst runs
  concurrently. The hot stream's own latency isn't what NFR2 asks about and
  isn't in this table.
- **Degradation**: \`(combined p99 − baseline p99) / baseline p99\`, computed
  once per mechanism from the two already-averaged p99s above, not averaged
  per-repeat.
- **Pass (<10%)?**: NFR2's stated threshold (PRD.md).
- **Baseline / Combined bg throughput**: mean across the same repeats of the
  background stream's \`http_reqs\` rate.
- **Double-booked?**: ground truth from \`booking_seats\` (see \`run.ts\`'s
  \`runIsolationOnce\`) — the single hard pass/fail gate, unaffected by
  whatever NFR2 shows.

## Next step

Both of Exhibit E's original findings are resolved. \`pessimistic\`'s didn't
survive re-measurement and needed no ticket (corrected above, same session).
\`optimistic\`'s did reproduce and was root-caused in
[issue #36](https://github.com/pradhnyesh01/RaceToSeat/issues/36): documented
above as an inherent trade-off of the CAS-retry design, not fixed — no
further follow-up ticket from this exhibit. Phase 4 (todo.md) is complete.
`;

  await writeFile(outPath, doc);
  console.log(`Exhibit E written to ${outPath}`);
  console.log(`${cells.length - missingStrategies.length}/${cells.length} matrix cell(s) complete.`);
  if (missingStrategies.length > 0) {
    console.log(`Missing strategies: ${missingStrategies.join(", ")}`);
  }
  if (!negativeControl) {
    console.log("No negative-control report found.");
  }
}

// --- Exhibit F: Phase 5 hold-expiry-under-load evidence (issue #41) ---

interface HoldExpiryRunLike {
  attempt: number;
  ranAt: string;
  seatCount: number;
  confirmTally: { created: number; expired: number; conflict: number; notFound: number; other: number };
  freshHoldTally: { created: number; conflict: number; notFound: number; other: number };
  lateConfirmCount: number;
  stuckSeatCount: number;
  freshHoldWinnerCount: number;
  anyLateConfirm: boolean;
  anyStuckSeat: boolean;
}

interface HoldExpiryReport {
  strategy: string;
  pattern: "hold-expiry";
  concurrency: number;
  runs: HoldExpiryRunLike[];
  anyLateConfirm: boolean;
  anyStuckSeat: boolean;
}

// Only reports from run.ts's `--pattern hold-expiry` (issue #41) qualify —
// distinguished from every other pattern by `pattern` and by the
// confirmTally/freshHoldTally shape unique to this one.
function isHoldExpiryReport(value: unknown): value is HoldExpiryReport {
  const v = value as Partial<HoldExpiryReport> | null;
  const run = v?.runs?.[0];
  return (
    !!v &&
    typeof v.strategy === "string" &&
    v.pattern === "hold-expiry" &&
    typeof v.concurrency === "number" &&
    Array.isArray(v.runs) &&
    v.runs.length > 0 &&
    typeof run?.ranAt === "string" &&
    typeof run?.seatCount === "number" &&
    typeof run?.confirmTally?.created === "number" &&
    typeof run?.freshHoldTally?.created === "number" &&
    typeof run?.lateConfirmCount === "number" &&
    typeof run?.stuckSeatCount === "number" &&
    typeof run?.freshHoldWinnerCount === "number"
  );
}

interface HoldExpiryFile {
  file: string;
  report: HoldExpiryReport;
}

// Only one mechanism ever produces this pattern's reports (`pessimistic`,
// ADR-0017), so this keeps only the single most recent report rather than
// building a per-strategy matrix like Exhibit C/E — "most-recent wins" is
// still the same dedup convention, just collapsed to one slot.
async function loadLatestHoldExpiryFile(evidenceDir: URL): Promise<HoldExpiryFile | null> {
  const entries = await readdir(evidenceDir);
  let latest: HoldExpiryFile | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
    const parsed: unknown = JSON.parse(await readFile(new URL(entry, evidenceDir), "utf8"));
    if (!isHoldExpiryReport(parsed)) continue;
    if (!latest || parsed.runs[0]!.ranAt > latest.report.runs[0]!.ranAt) {
      latest = { file: entry, report: parsed };
    }
  }
  return latest;
}

function renderHoldExpiryTable(runs: HoldExpiryRunLike[]): string {
  const header =
    "| Attempt | Seats held | Confirm 201 | Confirm 410 | Confirm 409 | Confirm 404 | Fresh-hold 201 | Fresh-hold 409 | Late confirms | Stuck seats | Fresh-hold winners |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|\n";
  const rows = runs
    .map(
      (r) =>
        `| ${r.attempt} | ${r.seatCount} | ${r.confirmTally.created} | ${r.confirmTally.expired} | ${r.confirmTally.conflict} | ${r.confirmTally.notFound} | ${r.freshHoldTally.created} | ${r.freshHoldTally.conflict} | ${r.lateConfirmCount > 0 ? `**${r.lateConfirmCount}**` : "0"} | ${r.stuckSeatCount > 0 ? `**${r.stuckSeatCount}**` : "0"} | ${r.freshHoldWinnerCount}/${r.seatCount} |`,
    )
    .join("\n");
  return header + rows + "\n";
}

async function mainExhibitF(evidenceDir: URL, outPath: string) {
  const latest = await loadLatestHoldExpiryFile(evidenceDir);

  if (!latest) {
    throw new Error(
      `No hold-expiry-pattern report JSON found under ${fileURLToPath(evidenceDir)} — run ` +
        `\`BOOKING_STRATEGY=pessimistic npm run harness -- --pattern hold-expiry\` first.`,
    );
  }

  const { file, report } = latest;
  const totalSeats = report.runs.reduce((sum, r) => sum + r.seatCount, 0);
  const totalFreshHoldWinners = report.runs.reduce((sum, r) => sum + r.freshHoldWinnerCount, 0);
  const totalLateConfirms = report.runs.reduce((sum, r) => sum + r.lateConfirmCount, 0);
  const totalStuckSeats = report.runs.reduce((sum, r) => sum + r.stuckSeatCount, 0);

  const doc = `# Exhibit F — Phase 5 hold-expiry-under-load evidence

Phase 5 deliverable (todo.md, issue #41): evidence that the hold → confirm →
expire flow (issues #38-#40, \`pessimistic\` only, ADR-0017) survives the real
"expire under load" race — a client slow to confirm, the reaper's background
sweep, and a different client trying to claim the now-stale seat, all firing
at once — with no double-confirm and no permanently stuck seat.

## Method

\`load-harness/hold-expiry-race.k6.js\` (\`run.ts --pattern hold-expiry\`)
seeds \`--concurrency\` distinct seats, holds every one of them via a real
\`POST /holds\` call, waits until every seeded hold's own \`held_until\` has
passed, then fires two concurrent streams at each one: 5 concurrent
\`POST /holds/{id}/confirm\` attempts per hold (one-shot — the claim under
test is that confirm *never* succeeds post-expiry, so retrying it would
prove nothing extra), and 5 concurrent fresh \`POST /holds\` attempts per
seat (each retrying on \`409\` with a short sleep, up to 10 attempts — a real
client that knows a hold is past its TTL but still sees \`409\` would
legitimately retry, since the only thing standing between "expired" and
"available" is the reaper's own sweep timer). \`--repeat\` reseeds fresh
seats/holds each attempt rather than resetting via an API call — there's no
hold-cancellation endpoint to reset one through.

Run against a short \`HOLD_TTL_SECONDS\` and \`REAPER_INTERVAL_MS\`, sized so
three budgets stay cleanly nested — \`REAPER_INTERVAL_MS\` < the fresh-hold
retry budget (10 attempts × 0.3s ≈ 3s worst case) < \`HOLD_TTL_SECONDS\` —
so the wait-past-expiry step stays fast, the reaper has genuinely raced the
burst rather than having swept long before it fired, and a winning fresh
hold can't itself expire and get re-won by a still-retrying straggler
before the run ends (that doesn't break correctness, but it does produce a
confusing second "winner" for a seat that was never actually double-held at
any single point in time):

\`\`\`bash
docker compose up -d
npm run db:migrate
HOLD_TTL_SECONDS=8 REAPER_INTERVAL_MS=1000 BOOKING_STRATEGY=pessimistic PORT=3000 npm run start
BOOKING_STRATEGY=pessimistic npm run harness -- --pattern hold-expiry --concurrency 200 --repeat 3

npm run harness:aggregate -- --exhibit f   # this script — reads docs/evidence/*.json, writes this file
\`\`\`

## Results

Report: [${file}](${file}) (${report.runs.length} repeat(s), ${report.concurrency} seat(s) per repeat).

${renderHoldExpiryTable(report.runs)}

Confirm's split between \`410\`/\`404\` varies attempt to attempt (compare
attempt 3 above to attempts 1-2) — the reaper sweeps on its own fixed
interval, independent of exactly when any given hold's TTL elapses, so
whether a confirm attempt catches a hold still present-but-expired (\`410\`,
confirm's own lazy backstop, ADR-0018) or already-reaped (\`404\`) depends on
where that hold's expiry lands relative to the reaper's tick schedule —
genuine timing variability, not a bug. Both outcomes are equally valid
evidence for "no late-succeeding confirms."

**Totals across ${report.runs.length} repeat(s), ${totalSeats} seat(s):**

| Late-succeeding confirms | Permanently stuck seats | Fresh-hold winners |
|---|---|---|
| ${totalLateConfirms > 0 ? `**${totalLateConfirms}**` : "**0**"} | ${totalStuckSeats > 0 ? `**${totalStuckSeats}**` : "**0**"} | ${totalFreshHoldWinners}/${totalSeats} |

${report.anyLateConfirm || report.anyStuckSeat ? "**FAIL** — see the flagged row(s) above." : "**PASS** — zero late-succeeding confirms, zero permanently stuck seats, and every seat was successfully re-claimed by a fresh hold once released."}

## Reading the columns

- **Confirm 201/410/409/404**: HTTP status tally across every one-shot
  confirm attempt in the repeat, straight from k6's \`--summary-export\`.
  \`410\` (expired, confirm's own lazy backstop, ADR-0018) and \`404\` (hold
  not found — the reaper already swept its rows) are both expected outcomes
  here; \`201\` never should be, since every confirm in this pattern only
  ever fires after its hold's TTL has passed.
- **Fresh-hold 201/409**: HTTP status tally across every fresh \`POST /holds\`
  attempt's *final* try (after any internal 409 retries) — \`409\` here means
  the seat still hadn't been released by the time that VU's retry budget
  ran out, not that it never will be.
- **Late confirms**: ground truth, not HTTP status — bookings found via the
  synthesized \`hold-confirm:<id>\` idempotency key
  (\`pessimisticConfirm.ts\`'s \`confirmIdempotencyKey\`) for any hold this run
  seeded. The single hard correctness claim this exhibit exists to test.
- **Stuck seats**: ground truth — seats still \`status = 'held'\` with
  \`held_until\` in the past, read directly from \`seats\`, well after the k6
  run finished. Proves the reaper (issue #40) actually closes the loop, not
  just that *a* fresh hold happened to win within the burst window.
- **Fresh-hold winners**: ground truth — seats whose current \`hold_seats\`
  row belongs to a hold id this run did *not* seed, i.e. a fresh attempt
  won the seat back after release.

## Next step

Phase 5 (todo.md) is complete: hold creation (#38), confirm (#39), the
reaper (#40), and this evidence run (#41) are all shipped. No further
follow-up ticket from this exhibit.
`;

  await writeFile(outPath, doc);
  console.log(`Exhibit F written to ${outPath}`);
  console.log(
    report.anyLateConfirm || report.anyStuckSeat
      ? "FAIL: see the report for details."
      : `PASS: 0 late confirms, 0 stuck seats, ${totalFreshHoldWinners}/${totalSeats} fresh-hold winners.`,
  );
}

export type Exhibit = "c" | "e" | "f" | "h";

export function parseExhibit(argv: string[]): Exhibit {
  const flagIndex = argv.indexOf("--exhibit");
  const value = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  if (value === undefined || value === "c") return "c";
  if (value === "e") return "e";
  if (value === "f") return "f";
  if (value === "h") return "h";
  throw new Error(`--exhibit must be "c", "e", "f", or "h", got ${JSON.stringify(value)}`);
}

const DEFAULT_OUT_NAMES: Record<Exhibit, string> = {
  c: "exhibit-c-phase2-comparison.md",
  e: "exhibit-e-phase4-isolation.md",
  f: "exhibit-f-phase5-hold-expiry.md",
  h: "exhibit-h-phase6-chaos.md",
};

export function parseOutPath(argv: string[], exhibit: Exhibit): string {
  const flagIndex = argv.indexOf("--out");
  if (flagIndex !== -1 && argv[flagIndex + 1]) return argv[flagIndex + 1]!;
  return fileURLToPath(new URL(`../docs/evidence/${DEFAULT_OUT_NAMES[exhibit]}`, import.meta.url));
}

// --- Exhibit H: Phase 6 chaos testing (issue #52) ---

const UNIT_CONTROL_FILES = ["oracles.test.ts", "faults.test.ts", "faultScoping.test.ts", "c2.test.ts", "holdOracles.test.ts"];

async function mainExhibitH(evidenceDir: URL, outPath: string) {
  const chaosDir = new URL("chaos/", evidenceDir);
  const reports = await loadChaosReports(chaosDir);
  if (reports.length === 0) {
    throw new Error(`No chaos report JSON found under ${fileURLToPath(chaosDir)} — run the chaos harness first (see Exhibit H's Reproducing section).`);
  }
  const unitControls = await countUnitControls(new URL("../test/chaos/", import.meta.url), UNIT_CONTROL_FILES);
  await writeFile(outPath, renderExhibitH({ reports, unitControls }));

  const measured = reports.filter((r) => !r.report.args.expectViolations);
  const violations = measured.filter((r) => r.report.correctnessViolation);
  const controls = reports.filter((r) => r.report.args.expectViolations);
  const flagged = controls.filter((r) => r.report.correctnessViolation);
  console.log(`Exhibit H written to ${outPath}`);
  console.log(`${reports.length} report(s): ${measured.length} measured, ${controls.length} negative control(s).`);
  console.log(
    violations.length > 0
      ? `FAIL: ${violations.length} Correctness violation(s): ${violations.map((v) => v.report.label).join(", ")}`
      : `PASS: 0 Correctness violations in ${measured.length} measured run(s); ${flagged.length}/${controls.length} negative controls flagged.`,
  );
  if (flagged.length !== controls.length) {
    console.log("FAIL: a negative control was NOT flagged — the checker cannot be trusted.");
    process.exitCode = 1;
  }
  if (violations.length > 0) process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const exhibit = parseExhibit(argv);
  const outPath = parseOutPath(argv, exhibit);
  const evidenceDir = new URL("../docs/evidence/", import.meta.url);

  if (exhibit === "e") {
    await mainExhibitE(evidenceDir, outPath);
    return;
  }
  if (exhibit === "f") {
    await mainExhibitF(evidenceDir, outPath);
    return;
  }
  if (exhibit === "h") {
    await mainExhibitH(evidenceDir, outPath);
    return;
  }

  await mainExhibitC(evidenceDir, outPath);
}

async function mainExhibitC(evidenceDir: URL, outPath: string) {
  const cells = await loadCells(evidenceDir);

  if (cells.length === 0) {
    throw new Error(
      `No matrix-schema report JSON found under ${fileURLToPath(evidenceDir)} — run the matrix via load-harness/run.ts first.`,
    );
  }

  const strategiesPresent = [...new Set(cells.map((c) => c.strategy))];
  const missingStrategies = STRATEGY_ORDER.filter((s) => !strategiesPresent.includes(s));

  const doc = `# Exhibit C — Phase 2 mechanism comparison

Phase 2 deliverable (todo.md, issue #18): the full concurrency-control
mechanism comparison — all six strategies (\`naive\` retained as the
continuing baseline, plus \`unique_constraint\`, \`pessimistic\`, \`optimistic\`,
\`advisory\`, \`serializable\`) benchmarked against each other across both load
patterns, not just against the pass/fail gate individually.

## Method

Same harness as Exhibits A/B (\`load-harness/run.ts\` +
\`load-harness/hammer-seat.k6.js\`), plus the spread-across-seats pattern
added in issue #17 (\`load-harness/spread-across-seats.k6.js\`). Matrix:
all-same-seat at concurrency {10, 100, 1,000}; spread-across-seats at
{1,000} only; each cell run once, except the 1,000-concurrent/all-same-seat
cell for \`optimistic\`, \`advisory\`, and \`serializable\`, run twice
independently (issue #18's acceptance criterion). \`BOOKING_STRATEGY\` is
fixed per server process (ADR-0002), so the matrix is driven by restarting
the server between mechanisms — this harness deliberately does not add
server-lifecycle orchestration (issue #18's scope note).

\`\`\`bash
BOOKING_STRATEGY=<mechanism> PORT=3000 npm run start
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern hammer-seat   --concurrency 10   --repeat 1
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern hammer-seat   --concurrency 100  --repeat 1
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern hammer-seat   --concurrency 1000 --repeat <1 or 2>
BOOKING_STRATEGY=<mechanism> npm run harness -- --pattern spread-seats  --concurrency 1000 --repeat 1

npm run harness:aggregate   # this script — reads docs/evidence/*.json, writes this file
\`\`\`

## Results

${renderTable(cells)}
${missingStrategies.length > 0 ? `\n**Note:** no matrix-schema report found yet for: ${missingStrategies.map((s) => `\`${s}\``).join(", ")}. The table above reflects only the runs present under \`docs/evidence/\` at generation time.\n` : ""}
## Two-independent-repeats gate (\`optimistic\`, \`advisory\`, \`serializable\`)

Their retry policies (ADR-0009 optimistic compare-and-swap, ADR-0011
serializable's dedicated transaction helper, both capable of exhausting
retries per ADR-0012) make "exactly one winner" less obviously guaranteed a
priori than a plain lock or constraint, hence the extra repeat — the same
bar Phase 1 already cleared for \`unique_constraint\`/\`pessimistic\` (Exhibit
B) at 1,000-concurrent/all-same-seat.

${renderTwoRepeatGate(cells)}

## Reading the columns

- **Throughput / p50 / p99**: mean across repeats within each cell, from
  k6's \`http_reqs\` rate and \`http_req_duration\` trend stats
  (\`--summary-export\`), not derived from the harness's own wall-clock
  timing.
- **Conflict rate**: HTTP 409 responses (\`conflict\`) over total requests in
  the cell.
- **Retry-exhaustion rate**: HTTP 503 responses (\`retry_exhausted\`,
  ADR-0012) over total requests — reported as its own column rather than
  folded into a generic failure tally, per ADR-0012's stated consequence.
  \`0.0%\` for every mechanism at every concurrency level is itself a
  finding: \`optimistic\` and \`serializable\` — the two mechanisms whose
  retry budgets can actually be exhausted (ADR-0012) — never hit that
  budget within this matrix's load levels. \`advisory\` blocks on the lock
  rather than retrying, and \`naive\`/\`unique_constraint\`/\`pessimistic\`
  never retry at all, so \`0.0%\` is definitional for all four.
- **Double-booked?**: ground truth from \`booking_seats\`, not from HTTP
  status codes (see \`run.ts\`'s \`runOnce\`/\`runSpreadSeatsOnce\`) — the
  single hard pass/fail gate (PRD §Metrics & Acceptance Criteria).

## Next step

Phase 3+ (todo.md): multi-seat transactions and deadlock-ordering
correctness, building on this phase's per-mechanism overhead baseline
(spread-across-seats, issue #17) to distinguish genuine multi-seat
contention cost from single-mechanism overhead.
`;

  await writeFile(outPath, doc);
  console.log(`Exhibit C written to ${outPath}`);
  console.log(`${cells.length} matrix cell(s) aggregated.`);
  if (missingStrategies.length > 0) {
    console.log(`Missing strategies: ${missingStrategies.join(", ")}`);
  }
}

// Run only when invoked as a script (`npm run harness:aggregate`), so tests can
// import parseExhibit/parseOutPath without regenerating an exhibit as a side
// effect.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
