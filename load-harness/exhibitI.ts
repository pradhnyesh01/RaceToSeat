// Exhibit I (issue #73, Phase 8 W1): what each Mechanism does when the Backstop
// is removed. The Backstop is the shared UNIQUE(seat_id) beneath every
// Mechanism and the Control (ADR-0008, CONTEXT.md); with it in place every
// Mechanism passes the exactly-one-winner gate, which cannot show that a
// Mechanism is correct on its own. This exhibit runs each one on a scratch
// database from which the constraint was dropped and reads the verdict from
// stored state (the chaos harness's Oracles), never from HTTP responses.

import { readdir, readFile } from "node:fs/promises";

// Only the fields of a chaos run report (load-harness/chaos/run.ts) this
// exhibit reads.
export interface ExhibitIReport {
  label: string;
  ranAt: string;
  args: { strategy: string; load: string; fault: string; db: string; concurrency: number };
  oracles: { oracle: number; name: string; passed: boolean; violations: { kind: string; detail?: string }[] }[];
  correctnessViolation: boolean;
  requestsIssued: number;
  k6: { statusTally: Record<string, number> };
  ambiguity: { bookingsCommittedBeforeReplay: number };
}

export interface LoadedExhibitIReport {
  file: string;
  report: ExhibitIReport;
}

// What one run showed about the Mechanism without the Backstop.
//   held          the Oracles passed and the load created Bookings
//   double-booked an Oracle failed: a Seat is claimed twice, or a Booking is torn
//   inoperative   nothing was booked at all: the Oracles pass on an empty
//                 database, which is not a pass (the Mechanism fails closed)
export type Verdict = "held" | "double-booked" | "inoperative";

export function verdictOf(report: ExhibitIReport): Verdict {
  if (report.correctnessViolation || report.oracles.some((o) => !o.passed)) return "double-booked";
  if (report.ambiguity.bookingsCommittedBeforeReplay === 0) return "inoperative";
  return "held";
}

// The five Mechanisms and the Control, in the order every exhibit lists them.
export const CONTROL = "naive";
export const STRATEGIES = ["naive", "unique_constraint", "pessimistic", "optimistic", "advisory", "serializable"] as const;
export const WORKLOADS = ["hammer-seat", "deadlock-pairs"] as const;

// Committed before any measured run (issue #72's spec, "Implementation Decisions" / W1):
// the Control and the unique-constraint Mechanism fail without the Backstop, the other four
// hold. The reason recorded for unique_constraint was that a conflict-ignoring insert with
// no unique index never conflicts; the smoke run showed the code's `ON CONFLICT (seat_id)`
// has a conflict target, which needs the index — so the prediction's *mechanism* was wrong
// even where its verdict ("does not stand alone") is right.
export const PREDICTIONS: Record<(typeof STRATEGIES)[number], "held" | "double-booked"> = {
  naive: "double-booked",
  unique_constraint: "double-booked",
  pessimistic: "held",
  optimistic: "held",
  advisory: "held",
  serializable: "held",
};

const VERDICTS = ["held", "double-booked", "inoperative"] as const;

function firstViolation(runs: ExhibitIReport[]): string | undefined {
  for (const run of runs) {
    for (const oracle of run.oracles) {
      const v = oracle.violations[0];
      if (!oracle.passed && v) return v.detail ?? v.kind;
    }
  }
  return undefined;
}

function cellText(runs: ExhibitIReport[]): string {
  const counts: Record<Verdict, number> = { held: 0, "double-booked": 0, inoperative: 0 };
  for (const run of runs) counts[verdictOf(run)] += 1;
  const text = VERDICTS.filter((v) => counts[v] > 0)
    .map((v) => `${v} ${counts[v]}/${runs.length}`)
    .join(", ");
  const detail = counts["double-booked"] > 0 ? firstViolation(runs) : undefined;
  return detail ? `${text} (${detail})` : text;
}

function predictionText(strategy: (typeof STRATEGIES)[number], runs: ExhibitIReport[]): string {
  if (runs.length === 0) return "—";
  return runs.every((r) => verdictOf(r) === PREDICTIONS[strategy]) ? "as predicted" : "prediction missed";
}

export function renderExhibitI(loaded: LoadedExhibitIReport[]): string {
  const rows: string[] = [];
  for (const strategy of STRATEGIES) {
    for (const load of WORKLOADS) {
      const runs = loaded.map((l) => l.report).filter((r) => r.args.strategy === strategy && r.args.load === load);
      rows.push(
        `| \`${strategy}\` | ${load} | ${strategy === CONTROL ? "Control" : "Mechanism"} | ${PREDICTIONS[strategy]} | ${runs.length} | ${
          runs.length === 0 ? "not run" : cellText(runs)
        } | ${predictionText(strategy, runs)} |`,
      );
    }
  }
  return [
    "| Strategy | Workload | Role | Predicted | Repeats | Without the Backstop | Prediction |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function isExhibitIReport(value: unknown): value is ExhibitIReport {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<ExhibitIReport>;
  return (
    typeof r.label === "string" &&
    typeof r.args?.strategy === "string" &&
    typeof r.args?.load === "string" &&
    Array.isArray(r.oracles) &&
    typeof r.ambiguity?.bookingsCommittedBeforeReplay === "number" &&
    typeof r.k6?.statusTally === "object"
  );
}

// Smoke runs (labelled `w1-smoke-`) only confirm a strategy starts and books on the
// Backstop-free database; they are kept as evidence of that and never counted as a
// measured repeat. Returns [] for a directory that does not exist yet.
export async function loadExhibitIReports(dir: URL): Promise<LoadedExhibitIReport[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((e) => e.endsWith(".json") && !e.startsWith(".")).sort();
  } catch {
    return [];
  }
  const loaded: LoadedExhibitIReport[] = [];
  for (const file of entries) {
    const parsed: unknown = JSON.parse(await readFile(new URL(file, dir), "utf8"));
    if (!isExhibitIReport(parsed) || parsed.label.startsWith("w1-smoke-")) continue;
    loaded.push({ file, report: parsed });
  }
  return loaded;
}
