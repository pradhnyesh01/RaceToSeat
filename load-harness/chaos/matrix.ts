// C2 fault-matrix driver (issue #49): runs the chaos orchestrator (run.ts) once
// per cell of mechanism x load x Fault x repeat, each as its own child process
// against its own throwaway scratch database, and leaves one JSON report per
// run under docs/evidence/chaos/ (summarize with summarize.ts).
//
// Resumable: a cell whose label already has a report is skipped, so a long
// matrix can be stopped and continued. Repeats are the OUTER loop so an
// interrupted matrix still covers every cell evenly.
//
// Unmodified-code runs and `--survive-uncaught` runs are separate variants with
// separate labels (`-survive`) and are never merged downstream (ADR-0022).
//
// Usage: tsx load-harness/chaos/matrix.ts [--mechanisms a,b] [--loads x,y]
//   [--faults f,g] [--reps 3] [--survive-faults f,g | none] [--only-survive]
//   [--app-port 3200] [--proxy-port 5440] [--toxiproxy-api http://localhost:8475]
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const ALL_MECHANISMS = ["naive", "unique_constraint", "pessimistic", "optimistic", "advisory", "serializable"];
const ALL_LOADS = ["hammer-seat", "deadlock-pairs"];
const ALL_FAULTS = ["latency-below", "latency-above", "partition-stall", "partition-reset", "app-sigkill"];

// Per-load request count: kept at or under ~60 so the load generator alone
// can't saturate macOS's 128-deep listen backlog (see C1 notes).
const CONCURRENCY: Record<string, number> = { "hammer-seat": 60, "deadlock-pairs": 30 };

const opts = {
  mechanisms: ALL_MECHANISMS,
  loads: ALL_LOADS,
  faults: ALL_FAULTS,
  reps: 3,
  surviveFaults: ["partition-stall", "partition-reset"],
  onlySurvive: false,
  appPort: 3200,
  proxyPort: 5440,
  toxiproxyApi: "http://localhost:8475",
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  const list = () => String(argv[++i]).split(",").filter((x) => x !== "" && x !== "none");
  if (flag === "--mechanisms") opts.mechanisms = list();
  else if (flag === "--loads") opts.loads = list();
  else if (flag === "--faults") opts.faults = list();
  else if (flag === "--reps") opts.reps = Number(argv[++i]);
  else if (flag === "--survive-faults") opts.surviveFaults = list();
  else if (flag === "--only-survive") opts.onlySurvive = true;
  else if (flag === "--app-port") opts.appPort = Number(argv[++i]);
  else if (flag === "--proxy-port") opts.proxyPort = Number(argv[++i]);
  else if (flag === "--toxiproxy-api") opts.toxiproxyApi = String(argv[++i]);
  else throw new Error(`Unknown argument: ${flag}`);
}

const evidenceDir = fileURLToPath(new URL("../../docs/evidence/chaos/", import.meta.url));
const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const runScript = fileURLToPath(new URL("./run.ts", import.meta.url));

function labelFor(fault: string, mechanism: string, load: string, survive: boolean, rep: number): string {
  return `c2-${fault}-${mechanism}-${load}${survive ? "-survive" : ""}-rep${rep}`;
}

function done(label: string): boolean {
  return readdirSync(evidenceDir).some((f) => f.startsWith(`${label}-20`) && f.endsWith(".json"));
}

// How long after the first transaction appears the timed Faults may land (a
// random 0..jitter on top of 20ms). A hammer-seat request is a single short
// transaction (losers fail fast), so its window is much narrower than
// deadlock-pairs'. Pass 1 (reps 1-3) used 400/250 for both loads and landed
// on in-flight work only about half the time for hammer-seat; passes after
// that use the tighter hammer-seat values. Every report records its own value.
const JITTER_MS: Record<string, { partition: number; kill: number }> = {
  "hammer-seat": { partition: 120, kill: 100 },
  "deadlock-pairs": { partition: 400, kill: 250 },
};

function faultArgs(fault: string, load: string, rep: number): string[] {
  const jitter = rep <= 3 ? { partition: 400, kill: 250 } : JITTER_MS[load]!;
  // A little constant latency for the Faults whose cut point would otherwise
  // land after a sub-second load is already over (partition, SIGKILL): it
  // stretches each transaction to a few hundred ms so a cut lands mid-flight.
  if (fault === "partition-stall" || fault === "partition-reset") return ["--base-latency-ms", "40", "--partition-ms", "7000", "--partition-jitter-ms", String(jitter.partition)];
  if (fault === "app-sigkill") return ["--base-latency-ms", "40", "--partition-jitter-ms", String(jitter.kill)];
  if (fault === "latency-above") return ["--latency-above-ms", "800"];
  return [];
}

function runOne(label: string, fault: string, mechanism: string, load: string, survive: boolean, rep: number): Promise<number | null> {
  const args = [
    runScript,
    "--strategy", mechanism,
    "--load", load,
    "--concurrency", String(CONCURRENCY[load]),
    "--fault", fault,
    "--db", "scratch",
    "--toxiproxy-api", opts.toxiproxyApi,
    "--proxy-port", String(opts.proxyPort),
    "--app-port", String(opts.appPort),
    "--request-timeout-ms", "5000",
    "--label", label,
    ...faultArgs(fault, load, rep),
    ...(survive ? ["--survive-uncaught"] : []),
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
  const cells: { fault: string; mechanism: string; load: string; survive: boolean; rep: number }[] = [];
  for (let rep = 1; rep <= opts.reps; rep += 1) {
    for (const fault of opts.faults) {
      for (const load of opts.loads) {
        for (const mechanism of opts.mechanisms) {
          if (!opts.onlySurvive) cells.push({ fault, mechanism, load, survive: false, rep });
          if (opts.surviveFaults.includes(fault)) cells.push({ fault, mechanism, load, survive: true, rep });
        }
      }
    }
  }
  const started = Date.now();
  let n = 0;
  const violations: string[] = [];
  const harnessErrors: string[] = [];
  for (const cell of cells) {
    n += 1;
    const label = labelFor(cell.fault, cell.mechanism, cell.load, cell.survive, cell.rep);
    if (done(label)) continue;
    const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`[${n}/${cells.length} +${elapsedMin}m] ${label}`);
    let code = await runOne(label, cell.fault, cell.mechanism, cell.load, cell.survive, cell.rep);
    // Exit 1 is shared between "Oracle violated" and "harness error"; a report on
    // disk distinguishes them. No report => harness error => retry once.
    if (code !== 0 && !done(label)) {
      console.log("    no report written (harness error) — retrying once");
      code = await runOne(label, cell.fault, cell.mechanism, cell.load, cell.survive, cell.rep);
    }
    if (code !== 0) {
      if (done(label)) {
        violations.push(label);
        console.log(`    *** CORRECTNESS VIOLATION reported by ${label} ***`);
      } else {
        harnessErrors.push(label);
      }
    }
  }
  console.log(`\nMatrix finished in ${((Date.now() - started) / 60000).toFixed(1)} min.`);
  console.log(`Correctness violations: ${violations.length}${violations.length ? `\n  ${violations.join("\n  ")}` : ""}`);
  console.log(`Harness errors (no report): ${harnessErrors.length}${harnessErrors.length ? `\n  ${harnessErrors.join("\n  ")}` : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
