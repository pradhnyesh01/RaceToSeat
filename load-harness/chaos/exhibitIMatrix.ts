// Exhibit I matrix driver (issue #73, Phase 8 W1): runs the chaos orchestrator (run.ts)
// once per cell of strategy x workload x repeat, each against its own throwaway database
// built from the real schema MINUS the Backstop (`--db scratch-no-unique`), with no Fault,
// and leaves one JSON report per run under docs/evidence/exhibit-i/ (a directory of its
// own, so Exhibit H's aggregation over docs/evidence/chaos/ never sees these runs).
// Render with `npm run harness:aggregate -- --exhibit i`.
//
// Same shape as matrix.ts, deliberately: resumable (a cell whose label already has a
// report is skipped), repeats are the OUTER loop so an interrupted run still covers every
// cell evenly, and exit 1 from run.ts is ambiguous between "an Oracle was violated" (a
// report is on disk) and "harness error" (none is, so it is retried once). A double-booking
// here is a *result*, not a failure of this driver.
//
// `--smoke` runs each cell once under the `w1-smoke-` label prefix: the ticket's first step,
// confirming every strategy starts and books normally on the Backstop-free database before
// any measured run, so that a setup problem is not read as a finding.
//
// Usage: tsx load-harness/chaos/exhibitIMatrix.ts [--strategies a,b] [--loads x,y]
//   [--reps 3] [--smoke] [--app-port 3100] [--proxy-port 5434]
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { STRATEGIES, WORKLOADS } from "../exhibitI.js";

const ALL_STRATEGIES: string[] = [...STRATEGIES];
const ALL_LOADS: string[] = [...WORKLOADS];

// Per-load request count, as in matrix.ts: at or under ~60 so the load generator alone
// cannot saturate macOS's 128-deep listen backlog (a deadlock-pairs "concurrency" is a
// number of pairs, so 30 means 60 requests).
const CONCURRENCY: Record<string, number> = { "hammer-seat": 60, "deadlock-pairs": 30 };

const opts = {
  strategies: ALL_STRATEGIES,
  loads: ALL_LOADS,
  reps: 3,
  smoke: false,
  appPort: 3100,
  proxyPort: 5434,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  const list = () => String(argv[++i]).split(",").filter((x) => x !== "");
  if (flag === "--strategies") opts.strategies = list();
  else if (flag === "--loads") opts.loads = list();
  else if (flag === "--reps") opts.reps = Number(argv[++i]);
  else if (flag === "--smoke") opts.smoke = true;
  else if (flag === "--app-port") opts.appPort = Number(argv[++i]);
  else if (flag === "--proxy-port") opts.proxyPort = Number(argv[++i]);
  else throw new Error(`Unknown argument: ${flag}`);
}
if (opts.smoke) opts.reps = 1;

const OUT_DIR = "docs/evidence/exhibit-i";
const evidenceDir = fileURLToPath(new URL(`../../${OUT_DIR}/`, import.meta.url));
mkdirSync(evidenceDir, { recursive: true });
const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const runScript = fileURLToPath(new URL("./run.ts", import.meta.url));

function labelFor(strategy: string, load: string, rep: number): string {
  return `w1-${opts.smoke ? "smoke-" : ""}${strategy}-${load}${opts.smoke ? "" : `-rep${rep}`}`;
}

function done(label: string): boolean {
  return readdirSync(evidenceDir).some((f) => f.startsWith(`${label}-20`) && f.endsWith(".json"));
}

function runOne(label: string, strategy: string, load: string): Promise<number | null> {
  const args = [
    runScript,
    "--strategy", strategy,
    "--load", load,
    "--concurrency", String(CONCURRENCY[load]),
    "--fault", "none",
    "--db", "scratch-no-unique",
    "--out-dir", OUT_DIR,
    "--proxy-port", String(opts.proxyPort),
    "--app-port", String(opts.appPort),
    "--request-timeout-ms", "5000",
    "--label", label,
  ];
  return new Promise((resolve) => {
    const child = spawn(tsx, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let tail = "";
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-1500);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("exit", (code) => {
      if (code !== 0) console.log(`    exit ${code}; last output:\n${tail.split("\n").map((l) => `      | ${l}`).join("\n")}`);
      resolve(code);
    });
  });
}

async function main(): Promise<void> {
  const cells: { strategy: string; load: string; rep: number }[] = [];
  for (let rep = 1; rep <= opts.reps; rep += 1) {
    for (const load of opts.loads) {
      for (const strategy of opts.strategies) cells.push({ strategy, load, rep });
    }
  }
  const started = Date.now();
  const flagged: string[] = [];
  const harnessErrors: string[] = [];
  let n = 0;
  for (const cell of cells) {
    n += 1;
    const label = labelFor(cell.strategy, cell.load, cell.rep);
    if (done(label)) continue;
    console.log(`[${n}/${cells.length} +${((Date.now() - started) / 60000).toFixed(1)}m] ${label}`);
    let code = await runOne(label, cell.strategy, cell.load);
    if (code !== 0 && !done(label)) {
      console.log("    no report written (harness error) — retrying once");
      code = await runOne(label, cell.strategy, cell.load);
    }
    if (code !== 0) {
      if (done(label)) flagged.push(label);
      else harnessErrors.push(label);
    }
  }
  console.log(`\nMatrix finished in ${((Date.now() - started) / 60000).toFixed(1)} min.`);
  console.log(`Runs where an Oracle flagged a violation (results, not errors): ${flagged.length}${flagged.length ? `\n  ${flagged.join("\n  ")}` : ""}`);
  console.log(`Harness errors (no report): ${harnessErrors.length}${harnessErrors.length ? `\n  ${harnessErrors.join("\n  ")}` : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
