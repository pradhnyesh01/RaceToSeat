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

// measured: a full-matrix run (`w1-<strategy>-<workload>-rep<n>`). smoke: confirms a strategy
// starts and books on the Backstop-free database. probe: the 1,000-request run that showed the
// chaos harness cannot carry that concurrency (see the document's concurrency section).
export type ReportKind = "measured" | "smoke" | "probe";

export interface LoadedExhibitIReport {
  file: string;
  report: ExhibitIReport;
  kind: ReportKind;
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

// Winners a fully served run would have: one for the single contested seat; one per pair of
// overlapping requests for deadlock-pairs (both orderings of each pair race for the same two
// seats, so exactly one can win, and requestsIssued is two per pair).
function expectedBookings(run: ExhibitIReport): number {
  return run.args.load === "deadlock-pairs" ? run.requestsIssued / 2 : 1;
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

function bookingsText(runs: ExhibitIReport[]): string {
  const created = runs.reduce((n, r) => n + r.ambiguity.bookingsCommittedBeforeReplay, 0);
  const expected = runs.reduce((n, r) => n + expectedBookings(r), 0);
  return `${created}/${expected}`;
}

function predictionText(strategy: (typeof STRATEGIES)[number], runs: ExhibitIReport[]): string {
  if (runs.length === 0) return "—";
  return runs.every((r) => verdictOf(r) === PREDICTIONS[strategy]) ? "as predicted" : "prediction missed";
}

function resultsTable(measured: ExhibitIReport[]): string {
  const rows: string[] = [];
  for (const strategy of STRATEGIES) {
    for (const load of WORKLOADS) {
      const runs = measured.filter((r) => r.args.strategy === strategy && r.args.load === load);
      rows.push(
        `| \`${strategy}\` | ${load} | ${strategy === CONTROL ? "Control" : "Mechanism"} | ${PREDICTIONS[strategy]} | ${runs.length} | ${
          runs.length === 0 ? "not run" : cellText(runs)
        } | ${runs.length === 0 ? "—" : bookingsText(runs)} | ${predictionText(strategy, runs)} |`,
      );
    }
  }
  return [
    "| Strategy | Workload | Role | Predicted | Repeats | Without the Backstop | Bookings created / expected | Prediction |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function statusText(report: ExhibitIReport): string {
  return Object.entries(report.k6.statusTally)
    .map(([status, n]) => `${n}x ${status}`)
    .join(", ");
}

function oracleText(report: ExhibitIReport): string {
  return report.oracles.map((o) => `${o.oracle}${o.passed ? "✓" : "✗"}`).join(" ");
}

function runTable(loaded: LoadedExhibitIReport[]): string {
  return [
    "| Run | Strategy | Workload | HTTP statuses | Bookings created | Oracles | Verdict | Report |",
    "|---|---|---|---|---|---|---|---|",
    ...loaded.map(
      ({ file, report }) =>
        `| ${report.label} | \`${report.args.strategy}\` | ${report.args.load} | ${statusText(report)} | ${report.ambiguity.bookingsCommittedBeforeReplay} | ${oracleText(report)} | ${verdictOf(report)} | [${file}](exhibit-i/${file}) |`,
    ),
  ].join("\n");
}

const MECHANISMS = STRATEGIES.filter((s) => s !== CONTROL);
// The Mechanisms that put a coordination step in front of the Backstop (CONTEXT.md): every
// Mechanism except the one that relies on the Backstop alone.
const COORDINATED = MECHANISMS.filter((s) => s !== "unique_constraint");

export function renderExhibitI(loaded: LoadedExhibitIReport[]): string {
  const measuredLoaded = loaded.filter((l) => l.kind === "measured");
  const measured = measuredLoaded.map((l) => l.report);
  const smoke = loaded.filter((l) => l.kind === "smoke");
  const probe = loaded.find((l) => l.kind === "probe");

  const of = (strategy: string) => measured.filter((r) => r.args.strategy === strategy);
  const control = of(CONTROL);
  const controlFlagged = control.filter((r) => verdictOf(r) === "double-booked").length;
  const coordinated = measured.filter((r) => (COORDINATED as readonly string[]).includes(r.args.strategy));
  const coordinatedHeld = coordinated.filter((r) => verdictOf(r) === "held").length;
  const uc = of("unique_constraint");
  const ucInoperative = uc.filter((r) => verdictOf(r) === "inoperative").length;
  const ucDoubleBooked = uc.filter((r) => verdictOf(r) === "double-booked").length;
  const asPredicted = STRATEGIES.filter((s) => of(s).length > 0 && of(s).every((r) => verdictOf(r) === PREDICTIONS[s]));
  const missed = STRATEGIES.filter((s) => of(s).length > 0 && !of(s).every((r) => verdictOf(r) === PREDICTIONS[s]));

  const controlHammer = control.filter((r) => r.args.load === "hammer-seat").map((r) => r.ambiguity.bookingsCommittedBeforeReplay);

  const underfilled = measured.filter((r) => verdictOf(r) === "held" && r.ambiguity.bookingsCommittedBeforeReplay < expectedBookings(r));
  const underfilledStrategies = [...new Set(underfilled.map((r) => r.args.strategy))];

  const out: string[] = [];
  out.push(`# Exhibit I — Phase 8: each Mechanism with the Backstop removed

Phase 8 deliverable (todo.md, issue #73 under the spec in #72). Every Mechanism passes the project's
one hard gate (exactly one winner per seat) on the shared schema, but that schema carries a
**Backstop** — a \`UNIQUE(seat_id)\` constraint beneath every Mechanism and the Control (ADR-0008,
CONTEXT.md) — so "all pass" does not show that a Mechanism is correct on its own. The only run that
ever removed the Backstop before this exhibit was the Control's (Exhibit A's history and Exhibit H's
negative controls). This exhibit removes it from each Mechanism and reports what is left.

Verdicts are read from stored database state by the chaos harness's four Oracles, never from HTTP
responses (ADR-0022). Every number below is recomputed from the per-run JSON reports in
\`docs/evidence/exhibit-i/\` by \`npm run harness:aggregate -- --exhibit i\`.

## Headline
`);
  out.push(
    `- **Detector check.** Control flagged in ${controlFlagged} of ${control.length} runs. The checker is known to see a double-booking at this load, so a "held" verdict below comes from a checker that can fail.`,
  );
  out.push(
    `- **The four coordinated Mechanisms** (${COORDINATED.map((s) => `\`${s}\``).join(", ")}) held in ${coordinatedHeld} of ${coordinated.length} measured runs, with the Backstop removed.`,
  );
  if (uc.length > 0) {
    out.push(
      `- **\`unique_constraint\` cannot stand alone**: ${ucInoperative} of ${uc.length} runs were inoperative${ucDoubleBooked > 0 ? ` and ${ucDoubleBooked} double-booked` : ""}. It is the Backstop relied on as the only defense, so removing the Backstop removes the Mechanism.`,
    );
  }
  out.push(
    `- **Predictions** (committed before any measured run): as predicted for ${asPredicted.map((s) => `\`${s}\``).join(", ") || "none"}${missed.length ? `; **missed** for ${missed.map((s) => `\`${s}\``).join(", ")}` : ""}.`,
  );
  if (underfilledStrategies.length > 0) {
    out.push(
      `- **Held is a safety verdict, not a liveness one**: ${underfilledStrategies.map((s) => `\`${s}\``).join(", ")} booked fewer Bookings than a fully served run would in ${underfilled.length} run(s) (see the "Bookings created / expected" column) without ever double-booking.`,
    );
  }
  out.push("");

  out.push(`## Method

For each strategy and workload, one chaos-harness run (\`load-harness/chaos/run.ts\`, no Fault) against a
throwaway database built from the real \`db/schema.sql\` with the Backstop constraints dropped by name
(\`--db scratch-no-unique\`, ADR-0023: the production schema, the application and the shared dev database are never touched).
The application under test is \`src/server.ts\`, unmodified. Every Idempotency Key is replayed afterwards, then the four
Oracles read stored state: (1) no Seat claimed by more than one Booking, (2) no torn Booking, (3) idempotent recovery,
(4) liveness.

- **Single-seat contention** (\`hammer-seat\`): 60 concurrent requests for one seat. A fully served run creates exactly 1 Booking.
- **Overlapping multi-seat pairs** (\`deadlock-pairs\`): 30 disjoint two-seat pairs, both orderings of each pair fired at once (60 requests).
  A fully served run creates 30 Bookings, one per pair. This tests the all-or-nothing property without the Backstop, not only mutual exclusion.
- **Repeats:** 3 per cell, driven by \`load-harness/chaos/exhibitIMatrix.ts\`. A **smoke run** of every strategy came first (below).
- **Predictions** were committed in \`load-harness/exhibitI.ts\` together with the smoke reports and before the first measured run:
  the Control and \`unique_constraint\` double-book without the Backstop; the other four hold.

\`\`\`bash
docker compose --profile chaos up -d toxiproxy
npx tsx load-harness/chaos/exhibitIMatrix.ts --smoke      # first: does each strategy start and book here?
npx tsx load-harness/chaos/exhibitIMatrix.ts --reps 3     # the measured matrix
npm run harness:aggregate -- --exhibit i                  # this document
\`\`\`
`);

  out.push(`## Results: predicted against observed

Verdicts: **held** (Oracles pass and Bookings were created), **double-booked** (an Oracle failed: a Seat claimed twice or a torn
Booking), **inoperative** (nothing was booked at all, so the Oracles pass on an empty database, which is not a pass).
\`naive\` is the Control, not a Mechanism (CONTEXT.md); its rows describe the Control *without* the Backstop, the only
configuration in which it fails.

${resultsTable(measured)}
`);

  if (uc.length > 0 && ucInoperative > 0) {
    out.push(`### \`unique_constraint\`: prediction missed — it fails closed instead of double-booking

The prediction was that \`unique_constraint\` would double-book, on the reasoning that a conflict-ignoring insert with no unique
index never conflicts. That is true of a target-less \`ON CONFLICT DO NOTHING\`. The code's insert names its conflict target
(\`ON CONFLICT (seat_id) DO NOTHING\`), and Postgres needs a unique index to arbitrate that, so with the Backstop dropped every
insert fails with error \`42P10\` ("no unique or exclusion constraint matching the ON CONFLICT specification"), answered as HTTP 500.
The Mechanism **fails closed**: it books nothing rather than booking twice. The conclusion the prediction was after (it cannot stand
alone) is right; the way it fails is not what was predicted. The Oracles pass here only because the database is
empty, which is why the verdict has a category for it.
`);
  }

  if (underfilledStrategies.length > 0) {
    out.push(`### Underfilled runs: held, but not fully served

${underfilled.length} run(s) kept every Oracle green yet created fewer Bookings than a fully served run: ${[...new Set(underfilled.map((r) => `\`${r.args.strategy}\` × ${r.args.load}`))].join(", ")}. The shortfall is consistent with each Mechanism's own documented behaviour under overlapping multi-seat load (ADR-0006, ADR-0013),
not with the Backstop's absence: \`serializable\`'s retry-exhaustion answers HTTP 503 and books nothing, and \`advisory\`'s non-blocking
\`pg_try_advisory_xact_lock\` can refuse both requests of a pair (the key replay that follows each run then books the missing pair). That
attribution is inferred from the mechanisms' design and the status tallies, not isolated by a separate with-Backstop run. It is
not a safety failure; it is reported so "held" is not read as "fully served".
`);
  }

  if (probe) {
    const unanswered = probe.report.k6.statusTally["0"] ?? 0;
    out.push(`## Why 60 concurrent, not 1,000

The spec asked for 1,000 concurrent single-seat requests. The chaos harness cannot carry that on this machine: a probe run at
${probe.report.requestsIssued} requests (\`${probe.file}\`) had **${unanswered} of ${probe.report.requestsIssued}** requests reset at the connection level
(no HTTP answer; the macOS listen backlog, \`kern.ipc.somaxconn\`, is 128), so only ${probe.report.requestsIssued - unanswered} reached the application, and the Control created ${probe.report.ambiguity.bookingsCommittedBeforeReplay} Booking(s) on the one seat
where the 60-request runs created ${controlHammer.length ? `${Math.min(...controlHammer)}–${Math.max(...controlHammer)}` : "—"}. A verdict of "held" under that noise would be weaker evidence, not stronger. The measured matrix therefore uses the
60-request ceiling every other chaos run in this project uses (Exhibit H), and the detector check above shows the Control is flagged at that level in
${controlFlagged} of ${control.length} runs. Exhibits B and C carry the 1,000-concurrent evidence, with the Backstop in place.
`);
  }

  if (smoke.length > 0) {
    out.push(`## Smoke runs

Before any measured run, one run of each strategy and workload confirmed it starts and books normally on the Backstop-free database, so that a setup
problem could not be mistaken for a result. Smoke reports are kept but never counted as measured repeats.

${runTable(smoke)}
`);
  }

  out.push(`## What this does and does not show

**Shows.** On a database without the Backstop, at this load, ${coordinatedHeld} of ${coordinated.length} runs of the four coordinated Mechanisms never claimed a Seat twice
and never tore a Booking, while the Control did in ${controlFlagged} of ${control.length}. Their own coordination step, not the Backstop, is what they rely on.
The unique-constraint Mechanism, by construction, relies on nothing else.

**Does not show.**

- *Not a proof.* 3 repeats of 60 requests are evidence at this load, not a guarantee; the formal track (Exhibit G) is where "holds in all interleavings" is checked, for the modelled protocol.
- *Not the production configuration.* Production keeps the Backstop. A Mechanism that fails here is not failing there; one that holds here has independent protection in addition to it.
- *Not a performance comparison.* Latency and throughput are Exhibit C's, with the Backstop in place.
- *Not Faults.* No Fault was injected (Exhibit H covers those, with the Backstop in place).
- *Not the hold/confirm flow.* Only booking claims were exercised.
- *One machine, containerized Postgres, one app process.*

## All runs

${runTable(measuredLoaded)}
`);
  return out.join("\n");
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

function kindOf(label: string): ReportKind {
  if (label.startsWith("w1-smoke-probe-")) return "probe";
  if (label.startsWith("w1-smoke-")) return "smoke";
  return "measured";
}

// Reads every chaos report in the directory, sorted by file name, and classifies it by label
// (see ReportKind). Returns [] for a directory that does not exist yet.
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
    if (!isExhibitIReport(parsed)) continue;
    loaded.push({ file, report: parsed, kind: kindOf(parsed.label) });
  }
  return loaded;
}
