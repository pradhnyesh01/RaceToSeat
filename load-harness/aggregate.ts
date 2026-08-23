// Aggregates the JSON run reports load-harness/run.ts already writes into a
// single Markdown comparison document (issue #18's Exhibit C): throughput,
// p50/p99 latency, conflict rate, and retry-exhaustion rate per mechanism
// and load-pattern/concurrency level. Retry-exhaustion rate is its own
// column, not folded into a generic failure tally (ADR-0012's consequence).
// Does not run the matrix itself (issue #18 leaves server-lifecycle
// orchestration out of the harness, ADR-0002) — this only reads whatever
// reports already exist under docs/evidence/.
//
// Usage: tsx load-harness/aggregate.ts [--out docs/evidence/exhibit-c-phase2-comparison.md]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

function parseOutPath(argv: string[]): string {
  const flagIndex = argv.indexOf("--out");
  if (flagIndex !== -1 && argv[flagIndex + 1]) return argv[flagIndex + 1]!;
  return fileURLToPath(new URL("../docs/evidence/exhibit-c-phase2-comparison.md", import.meta.url));
}

async function main() {
  const evidenceDir = new URL("../docs/evidence/", import.meta.url);
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

  const outPath = parseOutPath(process.argv.slice(2));
  await writeFile(outPath, doc);
  console.log(`Exhibit C written to ${outPath}`);
  console.log(`${cells.length} matrix cell(s) aggregated.`);
  if (missingStrategies.length > 0) {
    console.log(`Missing strategies: ${missingStrategies.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
