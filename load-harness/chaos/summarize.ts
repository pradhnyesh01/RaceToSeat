// Summarizes the C2 fault-matrix reports (issue #49) into Markdown tables:
// one per Fault, mechanism x load, with unmodified-code runs and
// `--survive-uncaught` runs kept in separate sections, never merged (ADR-0022).
// A deliberately small standalone reader — not an `aggregate.ts --exhibit` mode:
// the polished Exhibit H belongs to C5 (#52).
//
// Usage: tsx load-harness/chaos/summarize.ts [--prefix c2-] [--out path.md]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Report {
  label: string;
  args: { strategy: string; load: string; fault: string; surviveUncaught: boolean; db: string };
  oracles: { oracle: number; passed: boolean; violations: { kind: string }[] }[];
  correctnessViolation: boolean;
  k6: { statusTally: Record<string, number>; clientTimeouts: number; maxRequestMs: number };
  app: { exits: unknown[]; injectedKills?: unknown[]; errorSignatures: Record<string, number> };
  stall: { maxOpenTxAgeMs: number; peakLockHolders: number };
  drain: { drainedAfterMs: number | null; timedOut: boolean };
  ambiguity: { committedUnacknowledged: number; requestsWithoutAnswer: number };
  networkFault?: { openTxWhenApplied?: number; appliedAtMs: number | null };
  appKill?: { openTxAtKill: (number | undefined)[]; kills: number };
  robustnessObservations: { id: string }[];
}

const argv = process.argv.slice(2);
let prefix = "c2-";
let out: string | undefined;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--prefix") prefix = String(argv[++i]);
  else if (argv[i] === "--out") out = String(argv[++i]);
}

const dir = fileURLToPath(new URL("../../docs/evidence/chaos/", import.meta.url));
const reports: Report[] = readdirSync(dir)
  .filter((f) => f.startsWith(prefix) && f.endsWith(".json") && !f.startsWith("c2-smoke"))
  .map((f) => JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as Report);

const MECHS = ["naive", "unique_constraint", "pessimistic", "optimistic", "advisory", "serializable"];
const LOADS = ["hammer-seat", "deadlock-pairs"];
const FAULTS = ["latency-below", "latency-above", "partition-stall", "partition-reset", "app-sigkill"];

// Did the Fault actually land on in-flight work? Latency always does; the timed
// Faults only count when app transactions were open at the instant they hit.
function landed(r: Report): boolean {
  if (r.args.fault === "app-sigkill") return (r.appKill?.openTxAtKill ?? []).some((n) => (n ?? 0) > 0);
  if (r.args.fault.startsWith("partition")) return (r.networkFault?.openTxWhenApplied ?? 0) > 0;
  return true;
}

const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

function cell(rs: Report[]): string {
  if (rs.length === 0) return "—";
  const n = rs.length;
  const oracleOk = rs.filter((r) => !r.correctnessViolation).length;
  const crashed = rs.filter((r) => r.app.exits.length > 0).length;
  const eff = rs.filter(landed).length;
  const unack = rs.reduce((s, r) => s + r.ambiguity.committedUnacknowledged, 0);
  const maxTx = Math.max(...rs.map((r) => r.stall.maxOpenTxAgeMs));
  const leaked = rs.filter((r) => r.drain.timedOut).length;
  const parts = [`${oracleOk === n ? "✅" : "❌"} ${oracleOk}/${n}`, `landed ${eff}/${n}`, `crash ${crashed}/${n}`];
  if (unack > 0) parts.push(`unack ${unack}`);
  parts.push(`tx≤${seconds(maxTx)}`);
  if (leaked > 0) parts.push(`LEAK ${leaked}`);
  return parts.join(" · ");
}

function section(title: string, survive: boolean): string[] {
  const rs = reports.filter((r) => r.args.surviveUncaught === survive && r.args.db === "scratch");
  const lines: string[] = [`## ${title}`, ""];
  if (rs.length === 0) return [...lines, "_no runs_", ""];
  const viol = rs.filter((r) => r.correctnessViolation);
  lines.push(
    `${rs.length} runs; **Correctness violations: ${viol.length}**${viol.length ? ` (${viol.map((r) => r.label).join(", ")})` : ""}. ` +
      `Cell legend: Oracle-clean runs/total · Fault landed on in-flight transactions · app process crashed (Robustness) · ` +
      `commits no client was told about · longest app transaction open · leaked (never-draining) transactions.`,
    "",
  );
  for (const fault of FAULTS) {
    const fr = rs.filter((r) => r.args.fault === fault);
    if (fr.length === 0) continue;
    lines.push(`### ${fault}`, "", `| mechanism | ${LOADS.join(" | ")} |`, `|---|${LOADS.map(() => "---").join("|")}|`);
    for (const mech of MECHS) {
      const cols = LOADS.map((load) => cell(fr.filter((r) => r.args.strategy === mech && r.args.load === load)));
      lines.push(`| ${mech} | ${cols.join(" | ")} |`);
    }
    lines.push("");
  }
  // R4 digest: stall / drain per Fault.
  lines.push("### Stall and drain per Fault (R4)", "", "| Fault | runs | longest app tx | max row-lock holders | longest drain after Fault cleared | transactions that never drained | client timeouts (total) | 5xx answers (total) |", "|---|---|---|---|---|---|---|---|");
  for (const fault of FAULTS) {
    const fr = rs.filter((r) => r.args.fault === fault);
    if (fr.length === 0) continue;
    const drains = fr.map((r) => r.drain.drainedAfterMs).filter((d): d is number => d !== null);
    const fives = fr.reduce((s, r) => s + Object.entries(r.k6.statusTally).filter(([k]) => k.startsWith("5") && k !== "503").reduce((a, [, v]) => a + v, 0), 0);
    lines.push(
      `| ${fault} | ${fr.length} | ${seconds(Math.max(...fr.map((r) => r.stall.maxOpenTxAgeMs)))} | ${Math.max(...fr.map((r) => r.stall.peakLockHolders))} | ${drains.length ? seconds(Math.max(...drains)) : "n/a"} | ${fr.filter((r) => r.drain.timedOut).length} | ${fr.reduce((s, r) => s + r.k6.clientTimeouts, 0)} | ${fives} |`,
    );
  }
  lines.push("");
  return lines;
}

const md = [
  ...section("Unmodified production code", false),
  ...section("With `--survive-uncaught` harness scaffolding (reported separately, never merged)", true),
].join("\n");
if (out) writeFileSync(out, md);
else console.log(md);
