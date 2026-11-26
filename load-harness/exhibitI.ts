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
  // The application's own error output, as the harness counted it (run.ts `errorSignatures`).
  app?: { errorSignatures?: Record<string, number> };
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
//   held            the Oracles passed and the load created Bookings
//   double-booked   Oracle 1 (a Seat in more than one Booking) or Oracle 2 (a torn Booking) failed
//   other-violation any other Oracle failed (idempotent recovery, liveness), or the run was
//                   flagged without Oracle 1 or 2 failing
//   inoperative     nothing was booked at all: the Oracles pass on an empty database, which
//                   is not a pass (the Mechanism fails closed)
export type Verdict = "held" | "double-booked" | "other-violation" | "inoperative";

export function verdictOf(report: ExhibitIReport): Verdict {
  const failed = report.oracles.filter((o) => !o.passed).map((o) => o.oracle);
  if (failed.some((n) => n === 1 || n === 2)) return "double-booked";
  if (failed.length > 0 || report.correctnessViolation) return "other-violation";
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

const VERDICTS = ["held", "double-booked", "other-violation", "inoperative"] as const;

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
  const counts: Record<Verdict, number> = { held: 0, "double-booked": 0, "other-violation": 0, inoperative: 0 };
  for (const run of runs) counts[verdictOf(run)] += 1;
  const text = VERDICTS.filter((v) => counts[v] > 0)
    .map((v) => `${v} ${counts[v]}/${runs.length}`)
    .join(", ");
  const detail = counts["double-booked"] + counts["other-violation"] > 0 ? firstViolation(runs) : undefined;
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
    "| Mechanism or Control | Workload | Role | Predicted | Repeats | Without the Backstop | Bookings created / expected | Prediction |",
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
    "| Run | Mechanism or Control | Workload | HTTP statuses | Bookings created | Oracles | Verdict | Report |",
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

// What each underfilled Mechanism's documented behaviour says about it (ADR-0006, ADR-0012,
// ADR-0013). A Mechanism not listed has no documented explanation, which the document says.
const UNDERFILL_ATTRIBUTION: Record<string, string> = {
  advisory:
    "`pg_try_advisory_xact_lock` is non-blocking (ADR-0006) and can refuse both requests of a pair; the key replay that follows each run then books the missing pair",
  serializable: "retry exhaustion answers HTTP 503 and books nothing (ADR-0012, ADR-0013)",
};

function mostCommon(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

export function renderExhibitI(loaded: LoadedExhibitIReport[]): string {
  const measuredLoaded = loaded.filter((l) => l.kind === "measured");
  const measured = measuredLoaded.map((l) => l.report);
  const smoke = loaded.filter((l) => l.kind === "smoke");
  const probe = loaded.find((l) => l.kind === "probe");

  const runsOf = (strategy: string) => measured.filter((r) => r.args.strategy === strategy);
  const control = runsOf(CONTROL);
  const controlFlagged = control.filter((r) => verdictOf(r) === "double-booked").length;
  const coordinated = measured.filter((r) => (COORDINATED as readonly string[]).includes(r.args.strategy));
  const coordinatedHeld = coordinated.filter((r) => verdictOf(r) === "held").length;
  const uniqueConstraintRuns = runsOf("unique_constraint");
  const failedClosed = uniqueConstraintRuns.length > 0 && uniqueConstraintRuns.every((r) => verdictOf(r) === "inoperative");
  const asPredicted = STRATEGIES.filter((s) => runsOf(s).length > 0 && runsOf(s).every((r) => verdictOf(r) === PREDICTIONS[s]));
  const missed = STRATEGIES.filter((s) => runsOf(s).length > 0 && !runsOf(s).every((r) => verdictOf(r) === PREDICTIONS[s]));

  // Run sizes and repeat counts come from the reports, not from the text of this document.
  const singleSeatN = mostCommon(measured.filter((r) => r.args.load === "hammer-seat").map((r) => r.args.concurrency));
  const pairsN = mostCommon(measured.filter((r) => r.args.load === "deadlock-pairs").map((r) => r.args.concurrency));
  const repeats = Math.max(0, ...STRATEGIES.flatMap((s) => WORKLOADS.map((w) => runsOf(s).filter((r) => r.args.load === w).length)));
  const oracleNames = (measured[0]?.oracles ?? []).map((o) => `(${o.oracle}) ${o.name}`).join(", ");
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

Verdicts are read from stored database state by the chaos harness's Oracles, never from HTTP
responses (ADR-0022). Every number below is recomputed from the per-run JSON reports in
\`docs/evidence/exhibit-i/\` by \`npm run harness:aggregate -- --exhibit i\`.

## Headline
`);
  if (control.length > 0) {
    out.push(
      controlFlagged === control.length
        ? `- **Detector check.** Control flagged in ${controlFlagged} of ${control.length} runs. The checker is known to see a double-booking at this load, so a "held" verdict below comes from a checker that can fail.`
        : `- **Detector check incomplete.** Control flagged in ${controlFlagged} of ${control.length} runs, so the checker missed a double-booking it should have seen; a "held" verdict below is weaker evidence than it looks.`,
    );
  }
  out.push(
    `- **The four coordinated Mechanisms** (${COORDINATED.map((s) => `\`${s}\``).join(", ")}) held in ${coordinatedHeld} of ${coordinated.length} measured runs, with the Backstop removed${
      coordinated.length > 0 && coordinatedHeld === coordinated.length ? "; in none of them was a Seat claimed twice or a Booking torn" : ""
    }.`,
  );
  if (uniqueConstraintRuns.length > 0) {
    out.push(
      failedClosed
        ? `- **\`unique_constraint\` cannot stand alone**: ${uniqueConstraintRuns.length} of ${uniqueConstraintRuns.length} runs were inoperative. It is the Backstop relied on as the only defense, so removing the Backstop removes the Mechanism.`
        : `- **\`unique_constraint\`**: ${cellText(uniqueConstraintRuns)} (see the table).`,
    );
  }
  out.push(
    `- **Predictions** (first written in issue #72, before any run; see "Order of events"): as predicted for ${asPredicted.map((s) => `\`${s}\``).join(", ") || "none"}${missed.length ? `; **missed** for ${missed.map((s) => `\`${s}\``).join(", ")}` : ""}.`,
  );
  if (probe && singleSeatN !== undefined) {
    out.push(
      `- **Concurrency ceiling.** Single-seat contention ran at ${singleSeatN} concurrent requests, not the 1,000 the spec asked for: the chaos harness could not carry 1,000 on this machine (see "Why ${singleSeatN} concurrent, not 1,000").`,
    );
  }
  if (underfilledStrategies.length > 0) {
    out.push(
      `- **Held is a safety verdict, not a liveness one**: ${underfilledStrategies.map((s) => `\`${s}\``).join(", ")} booked fewer Bookings than a fully served run would in ${underfilled.length} run(s) (see the "Bookings created / expected" column) without ever double-booking.`,
    );
  }
  out.push("");

  out.push(`## Method

For each Mechanism and the Control, and each workload, one chaos-harness run (\`load-harness/chaos/run.ts\`, no Fault) against a
throwaway database built from the real \`db/schema.sql\` with the Backstop (its \`UNIQUE(seat_id)\` constraints) dropped by name
(\`--db scratch-no-unique\`, ADR-0023: the production schema, the application and the shared dev database are never touched).
The application under test is \`src/server.ts\`, unmodified. Every Idempotency Key is replayed afterwards, then the Oracles
read stored state: ${oracleNames || "—"}.

- **Single-seat contention** (\`hammer-seat\`): ${singleSeatN ?? "—"} concurrent requests for one seat. A fully served run creates exactly 1 Booking.
- **Overlapping multi-seat pairs** (\`deadlock-pairs\`): ${pairsN ?? "—"} disjoint two-seat pairs, both orderings of each pair fired at once (${pairsN === undefined ? "—" : pairsN * 2} requests).
  A fully served run creates ${pairsN ?? "—"} Bookings, one per pair. This tests the all-or-nothing property without the Backstop, not only mutual exclusion.
- **Repeats:** ${repeats} per cell, driven by \`load-harness/chaos/exhibitIMatrix.ts\`. A **smoke run** of every strategy came first (below).

**Order of events.** The predictions were first written in issue #72, before any run: the Control and \`unique_constraint\` double-book
without the Backstop; the other four hold. The smoke runs came next, and had already contradicted the \`unique_constraint\` prediction (every
insert failed) by the time \`PREDICTIONS\` was committed in \`load-harness/exhibitI.ts\`; it was kept as written, so the miss is visible
and not edited away. The \`inoperative\` verdict was added after that smoke result, because the Oracles pass on an empty database. The measured
matrix ran after all of that.

\`\`\`bash
docker compose --profile chaos up -d toxiproxy
npx tsx load-harness/chaos/exhibitIMatrix.ts --smoke      # first: does each strategy start and book here?
npx tsx load-harness/chaos/exhibitIMatrix.ts --reps 3     # the measured matrix
npm run harness:aggregate -- --exhibit i                  # this document
\`\`\`
`);

  out.push(`## Results: predicted against observed

Verdicts: **held** (Oracles pass and Bookings were created), **double-booked** (the Oracle for Seat exclusivity or for torn Bookings failed: a Seat claimed
twice, or a Booking that does not hold the Seats it asked for), **other-violation** (any other Oracle failed), **inoperative** (nothing was booked at all, so the
Oracles pass on an empty database, which is not a pass). \`naive\` is the Control, not a Mechanism (CONTEXT.md); its rows describe the Control *without*
the Backstop, the only configuration in which it fails.

${resultsTable(measured)}
`);

  if (failedClosed) {
    const signatures = new Map<string, number>();
    for (const r of uniqueConstraintRuns) {
      for (const [message, n] of Object.entries(r.app?.errorSignatures ?? {})) {
        if (message.includes("ON CONFLICT")) signatures.set(message, (signatures.get(message) ?? 0) + n);
      }
    }
    const all500 = uniqueConstraintRuns.every((r) => Object.keys(r.k6.statusTally).every((s) => s === "500"));
    out.push(`### \`unique_constraint\`: prediction missed — it fails closed instead of double-booking
`);
    if (signatures.size > 0) {
      const [message, n] = [...signatures.entries()][0]!;
      out.push(`The prediction was that \`unique_constraint\` would double-book, on the reasoning that a conflict-ignoring insert with no unique index never
conflicts. That is true of a target-less \`ON CONFLICT DO NOTHING\`. The code's insert names its conflict target (\`ON CONFLICT (seat_id) DO NOTHING\`), and
Postgres needs a unique index to arbitrate that. The reports record the application's own error, ${n} times across these runs: \`${message}\`.
The Mechanism **fails closed**: it books nothing rather than booking twice.${
        all500 ? " The failure is answered as an unclassified HTTP 500 (not one of the designed outcomes, ADR-0025), which matters only because this is not a configuration the system ships." : ""
      } The conclusion the prediction was
after (it cannot stand alone) is right; the way it fails is not what was predicted. The Oracles pass here only because the database is empty, which is why
the verdict has a category for it.
`);
    } else {
      out.push(`Every run booked nothing, and these reports did not record the cause. The prediction was that \`unique_constraint\` would double-book; the observed outcome is
the opposite failure (nothing booked), so the prediction's mechanism was wrong even if its conclusion (it cannot stand alone) is right. The Oracles pass only
because the database is empty, which is why the verdict has a category for it.
`);
    }
  }

  if (underfilledStrategies.length > 0) {
    out.push(`### Underfilled runs: held, but not fully served

${underfilled.length} run(s) kept every Oracle green yet created fewer Bookings than a fully served run:
${underfilledStrategies
  .map((s) => `- \`${s}\`: ${UNDERFILL_ATTRIBUTION[s] ?? "no documented explanation — treat this as a finding to investigate, not as a known behaviour"}`)
  .join("\n")}

Where an explanation is given it is inferred from the Mechanism's design and the status tallies, not isolated by a separate with-Backstop run. None of this is a safety
failure; it is reported so "held" is not read as "fully served".
`);
  }

  if (probe) {
    const unanswered = probe.report.k6.statusTally["0"] ?? 0;
    out.push(`## Why ${singleSeatN ?? "—"} concurrent, not 1,000

The spec asked for 1,000 concurrent single-seat requests. The chaos harness could not carry that on this machine. One probe, on the Control only, at
${probe.report.requestsIssued} requests (\`${probe.file}\`) had **${unanswered} of ${probe.report.requestsIssued}** requests reset at the connection level
(no HTTP answer), so only ${probe.report.requestsIssued - unanswered} reached the application, and the Control created ${probe.report.ambiguity.bookingsCommittedBeforeReplay} Booking(s) on the one seat
where the ${singleSeatN ?? "—"}-request runs created ${controlHammer.length ? `${Math.min(...controlHammer)}–${Math.max(...controlHammer)}` : "—"}. That is consistent with the macOS listen backlog (\`kern.ipc.somaxconn\` read as
128 on the machine that ran this; the report does not record it). A verdict of "held" under that noise would be weaker evidence, not stronger. The measured matrix
therefore stays at the ceiling the project's other chaos matrices use (Exhibit H), and the detector check above is the evidence that this level is enough to
expose a double-booking. No level between ${singleSeatN ?? "—"} and 1,000 was tried. Exhibits B and C carry the 1,000-concurrent evidence, with the Backstop in place.
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

**Shows.** On a database without the Backstop, at this load, ${
    coordinated.length > 0 && coordinatedHeld === coordinated.length
      ? `${coordinatedHeld} of ${coordinated.length} runs of the four coordinated Mechanisms never claimed a Seat twice and never tore a Booking${
          control.length > 0 ? `, while the Control did in ${controlFlagged} of ${control.length}` : ""
        }. Their own coordination step, not the Backstop, is what they rely on.`
      : `the four coordinated Mechanisms held in ${coordinatedHeld} of ${coordinated.length} runs; the table shows which runs did not.`
  } The unique-constraint Mechanism, by construction, relies on nothing else.

**Does not show.**

- *Not a proof.* ${repeats} repeats of ${singleSeatN ?? "—"} requests are evidence at this load, not a guarantee; the formal track (Exhibit G) is where "holds in all interleavings" is checked, for the modelled protocol.${
    probe ? `\n- *Concurrency below the spec's 1,000.* Single-seat contention ran at ${singleSeatN ?? "—"}, because the chaos harness could not carry 1,000 here (one probe, on the Control only; no level in between was tried).` : ""
  }
- *Not the production configuration.* Production keeps the Backstop. A Mechanism that fails here is not failing there; one that holds here has independent protection in addition to it.
- *Not a performance comparison.* Latency and throughput are Exhibit C's, with the Backstop in place.
- *Not Faults.* No Fault was injected (Exhibit H covers those, with the Backstop in place).
- *Not the hold/confirm flow.* Only booking claims were exercised.
- *One machine, containerized Postgres, one app process.*

## Decision record

No ADR was written for this exhibit. Nothing in it is hard to reverse (a new exhibit, a harness flag and a driver), and its result is a measurement, not a choice between alternatives;
what it means for the recommendation belongs to the recommendation-matrix ticket (#75) and the writeup (#76).

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
    typeof r.args?.concurrency === "number" &&
    typeof r.requestsIssued === "number" &&
    typeof r.correctnessViolation === "boolean" &&
    r.oracles.every((o) => typeof o?.oracle === "number" && typeof o?.passed === "boolean") &&
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
// (see ReportKind). Returns [] for a directory that does not exist yet; any other read error is raised.
export async function loadExhibitIReports(dir: URL): Promise<LoadedExhibitIReport[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((e) => e.endsWith(".json") && !e.startsWith(".")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const loaded: LoadedExhibitIReport[] = [];
  for (const file of entries) {
    const parsed: unknown = JSON.parse(await readFile(new URL(file, dir), "utf8"));
    if (!isExhibitIReport(parsed)) continue;
    loaded.push({ file, report: parsed, kind: kindOf(parsed.label) });
  }
  return loaded;
}
