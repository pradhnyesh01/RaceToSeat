// C4 matrix driver (issue #51): runs runRestart.ts once per cell, each as its
// own child process against its own scratch Postgres container, and leaves one
// JSON report per run under docs/evidence/chaos/c4-restart/.
//
// Cells (3 repeats each, repeats as the OUTER loop so an interrupted matrix
// still covers every cell evenly; resumable: a label that already has a report
// is skipped):
//   main      stock Postgres, three shutdown modes x three loads, plus a
//             short-TTL hold variant that expires holds during the outage
//   baseline  no Fault, the same three loads (what "normal" looks like here)
//   long      (on request) a 15 s outage instead of 3 s
//   control   the unsafe-Postgres negative controls: a hard kill must flag
//             Oracle 5 (--expect-violations); the orderly restart of the SAME
//             unsafe server is the reference that must not
//
// Usage: tsx load-harness/chaos/restartMatrix.ts [--reps 3] [--only main|baseline|control|long]
//   [--app-port 3400]
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Cell {
  prefix: "c4" | "c4base" | "c4ctl" | "c4ref";
  variant: "restart" | "stop" | "kill" | "none";
  load: "spread" | "hammer" | "holds";
  profile: "safe" | "unsafe";
  // Distinguishes the short-TTL hold cell in its label.
  tag?: string;
  extra: string[];
  expectViolations: boolean;
}

const LOADS: Record<string, string[]> = {
  spread: ["--seats", "4000", "--workers", "30", "--think-ms", "60"],
  hammer: ["--seats", "250", "--workers", "30", "--think-ms", "20"],
  holds: ["--seats", "1500", "--workers", "30", "--think-ms", "60"],
};

const reps = (() => {
  const i = process.argv.indexOf("--reps");
  return i >= 0 ? Number(process.argv[i + 1]) : 3;
})();
const only = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? String(process.argv[i + 1]) : "all";
})();
const appPort = (() => {
  const i = process.argv.indexOf("--app-port");
  return i >= 0 ? process.argv[i + 1]! : "3400";
})();

const cells: Cell[] = [];
const add = (c: Omit<Cell, "extra" | "expectViolations"> & { extra?: string[]; expectViolations?: boolean }) =>
  cells.push({ extra: [], expectViolations: false, ...c });

if (only === "all" || only === "main") {
  for (const load of ["spread", "hammer", "holds"] as const) {
    for (const variant of ["restart", "stop", "kill"] as const) add({ prefix: "c4", variant, load, profile: "safe" });
  }
  for (const variant of ["restart", "kill"] as const) add({ prefix: "c4", variant, load: "holds", profile: "safe", tag: "short", extra: ["--hold-ttl-seconds", "4"] });
}
// A long outage (15 s, longer than every database bound R4 added and than a hold's TTL),
// run on request only: it is the cell where "does the app recover on its own" is least obvious.
if (only === "long") {
  for (const load of ["spread", "holds"] as const) add({ prefix: "c4", variant: "kill", load, profile: "safe", tag: "down15s", extra: ["--down-ms", "15000"] });
}
if (only === "all" || only === "baseline") {
  for (const load of ["spread", "hammer", "holds"] as const) add({ prefix: "c4base", variant: "none", load, profile: "safe" });
}
if (only === "all" || only === "control") {
  for (const load of ["spread", "hammer", "holds"] as const) add({ prefix: "c4ctl", variant: "kill", load, profile: "unsafe", expectViolations: true });
  add({ prefix: "c4ref", variant: "restart", load: "spread", profile: "unsafe" });
}

const evidenceDir = fileURLToPath(new URL("../../docs/evidence/chaos/c4-restart/", import.meta.url));
mkdirSync(evidenceDir, { recursive: true });
const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const runScript = fileURLToPath(new URL("./runRestart.ts", import.meta.url));

const labelFor = (c: Cell, rep: number) => `${c.prefix}-${c.variant}-${c.load}${c.tag ? `-${c.tag}` : ""}-${c.profile}-rep${rep}`;
const done = (label: string) => readdirSync(evidenceDir).some((f) => f.startsWith(`${label}-20`) && f.endsWith(".json"));

function runOne(c: Cell, label: string): Promise<number | null> {
  const args = [runScript, "--variant", c.variant, "--load", c.load, "--profile", c.profile, ...LOADS[c.load]!, ...c.extra, "--label", label, "--app-port", appPort, ...(c.expectViolations ? ["--expect-violations"] : [])];
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
  const started = Date.now();
  const violations: string[] = [];
  const harnessErrors: string[] = [];
  let n = 0;
  const total = cells.length * reps;
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const c of cells) {
      n += 1;
      const label = labelFor(c, rep);
      if (done(label)) continue;
      console.log(`[${n}/${total} +${((Date.now() - started) / 60000).toFixed(1)}m] ${label}`);
      let code = await runOne(c, label);
      if (code !== 0 && !done(label)) {
        console.log("    no report written (harness error) — retrying once");
        code = await runOne(c, label);
      }
      if (code !== 0) (done(label) ? violations : harnessErrors).push(label);
    }
  }
  console.log(`\nMatrix finished in ${((Date.now() - started) / 60000).toFixed(1)} min.`);
  console.log(`Runs with a nonzero verdict (a violation on a measured run, or a control that did not go red): ${violations.length}${violations.length ? `\n  ${violations.join("\n  ")}` : ""}`);
  console.log(`Harness errors (no report): ${harnessErrors.length}${harnessErrors.length ? `\n  ${harnessErrors.join("\n  ")}` : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
