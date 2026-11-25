// Tests for `aggregate.ts --exhibit h` (issue #52, C5) and load-harness/exhibitH.ts.
//
// No database needed: these read the committed JSON reports under
// docs/evidence/chaos/ or feed the renderer small synthetic ones. The golden
// check at the bottom is what makes the committed Exhibit H a *regenerated*
// artifact, like Exhibits C/E/F: change a report (or a test-file count the
// exhibit cites) without re-running `npm run harness:aggregate -- --exhibit h`
// and this fails.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseExhibit, parseOutPath } from "../load-harness/aggregate.js";
import {
  CANONICAL_FINDINGS,
  FORMAL_FINDINGS,
  checkRecordClaims,
  classify,
  computeFindingEvidence,
  countUnitControls,
  loadChaosReports,
  matrixCell,
  renderExhibitH,
  type ChaosArgs,
  type ChaosGroup,
  type ChaosReport,
  type LoadedChaosReport,
} from "../load-harness/exhibitH.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const chaosDir = new URL("../docs/evidence/chaos/", import.meta.url);

const PASS_ORACLES = [1, 2, 3, 4].map((n) => ({ oracle: n, name: `oracle ${n}`, passed: true, violations: [] }));

type Over = Omit<Partial<ChaosReport>, "args"> & { args?: Partial<ChaosArgs> };

function mk(label: string, over: Over = {}): ChaosReport {
  const { args, ...rest } = over;
  return {
    label,
    ranAt: "2026-11-25T00:00:00.000Z",
    args: { strategy: "naive", load: "hammer-seat", fault: "partition-stall", surviveUncaught: false, expectViolations: false, ...args },
    oracles: PASS_ORACLES,
    correctnessViolation: false,
    k6: { statusTally: { "201": 1, "409": 59 }, clientTimeouts: 0, maxRequestMs: 50 },
    app: { exits: [], errorSignatures: {} },
    stall: { maxOpenTxAgeMs: 120, peakLockHolders: 1 },
    drain: { drainedAfterMs: 3, timedOut: false },
    ambiguity: { committedUnacknowledged: 0, requestsWithoutAnswer: 0 },
    requestsIssued: 60,
    robustnessObservations: [],
    ...rest,
  };
}

function load(report: ChaosReport): LoadedChaosReport {
  return { file: `${report.label}.json`, report, group: classify(report) };
}

describe("--exhibit wiring", () => {
  it("defaults to Exhibit C, so `npm run harness:aggregate` is unchanged", () => {
    expect(parseExhibit([])).toBe("c");
    expect(parseExhibit(["--out", "x.md"])).toBe("c");
    expect(parseExhibit(["--exhibit", "c"])).toBe("c");
  });

  it("accepts e, f and h, and rejects anything else", () => {
    expect(parseExhibit(["--exhibit", "e"])).toBe("e");
    expect(parseExhibit(["--exhibit", "f"])).toBe("f");
    expect(parseExhibit(["--exhibit", "h"])).toBe("h");
    expect(() => parseExhibit(["--exhibit", "g"])).toThrow(/"c", "e", "f", or "h"/);
  });

  it("writes Exhibit H to its own default file, and honours --out", () => {
    expect(parseOutPath([], "h")).toMatch(/docs\/evidence\/exhibit-h-phase6-chaos\.md$/);
    expect(parseOutPath([], "c")).toMatch(/docs\/evidence\/exhibit-c-phase2-comparison\.md$/);
    expect(parseOutPath(["--out", "/tmp/x.md"], "h")).toBe("/tmp/x.md");
  });
});

describe("classify", () => {
  const cases: [string, Over, ChaosGroup][] = [
    ["first-run-backend-kill", { args: { fault: "backend-kill" } }, "c1-unmodified"],
    ["survive-kill-rep1", { args: { fault: "backend-kill", surviveUncaught: true } }, "c1-scaffolded"],
    ["negctl-naive-scratch-rep1", { args: { fault: "none", expectViolations: true } }, "c1-control"],
    ["negctl-naive-shared-schema", { args: { fault: "none" } }, "c1-control-real-schema"],
    ["c2-partition-stall-naive-hammer-seat-rep1", {}, "c2-unmodified"],
    ["c2-partition-stall-naive-hammer-seat-survive-rep1", { args: { surviveUncaught: true } }, "c2-scaffolded"],
    ["c2long-partition-stall-advisory-deadlock-pairs", {}, "c2-long"],
    ["c2adv-nofault-advisory-hammer-rep1", { args: { fault: "none" } }, "c2-nofault-advisory"],
    ["c2ctl-latency-above-naive-no-unique-rep1", { args: { expectViolations: true } }, "c2-control"],
    ["c3-baseline-hold-expiry-nofault", { args: { mode: "hold-expiry", fault: "none" } }, "c3-baseline"],
    ["c3-control-reaperstall-nofault", { args: { mode: "hold-expiry", fault: "none", reaperStallSeats: 3 } }, "c3-reaperstall-nofault"],
    ["c3-unmodified-hold-confirm-rep1", { args: { mode: "hold-confirm", fault: "backend-kill" } }, "c3-unmodified"],
    ["c3-survive-hold-confirm-rep1", { args: { mode: "hold-confirm", fault: "backend-kill", surviveUncaught: true } }, "c3-scaffolded"],
    ["c3-negctl-late-confirm", { args: { mode: "hold-expiry", fault: "none", expectViolations: true } }, "c3-control"],
  ];
  for (const [label, over, group] of cases) {
    it(`${label} → ${group}`, () => {
      expect(classify(mk(label, over))).toBe(group);
    });
  }
});

describe("matrixCell", () => {
  it("is empty for no runs", () => {
    expect(matrixCell([])).toBe("—");
  });

  it("reports clean runs, landed Faults, crashes, unacknowledged commits and longest transaction", () => {
    const rs = [
      mk("a", { networkFault: { kind: "partition-stall", openTxWhenApplied: 5 }, app: { exits: [{}], errorSignatures: {} }, ambiguity: { committedUnacknowledged: 3, requestsWithoutAnswer: 0 }, stall: { maxOpenTxAgeMs: 7100, peakLockHolders: 2 } }),
      mk("b", { networkFault: { kind: "partition-stall", openTxWhenApplied: 0 } }),
    ];
    expect(matrixCell(rs)).toBe("✅ 2/2 · landed 1/2 · crash 1/2 · unack 3 · tx≤7.1s");
  });

  it("goes ❌ the moment any Oracle failed, and flags leaked transactions", () => {
    const rs = [mk("a", { correctnessViolation: true, drain: { drainedAfterMs: null, timedOut: true } }), mk("b")];
    expect(matrixCell(rs)).toContain("❌ 1/2");
    expect(matrixCell(rs)).toContain("LEAK 1");
  });
});

describe("renderExhibitH on synthetic reports", () => {
  it("keeps unmodified and scaffolded runs in separate sections, never merged (ADR-0022)", () => {
    const unmodified = mk("c2-partition-stall-naive-hammer-seat-rep1", { app: { exits: [{}], errorSignatures: {} }, networkFault: { kind: "partition-stall", openTxWhenApplied: 3 } });
    const scaffolded = mk("c2-partition-stall-naive-hammer-seat-survive-rep1", { args: { surviveUncaught: true }, networkFault: { kind: "partition-stall", openTxWhenApplied: 3 } });
    const doc = renderExhibitH({ reports: [load(unmodified), load(scaffolded)], unitControls: null });
    const a = doc.slice(doc.indexOf("### A. Unmodified"), doc.indexOf("### B. With the"));
    const b = doc.slice(doc.indexOf("### B. With the"), doc.indexOf("### C. Long partition"));
    expect(a).toContain("| naive | ✅ 1/1 · landed 1/1 · crash 1/1");
    expect(b).toContain("| naive | ✅ 1/1 · landed 1/1 · crash 0/1");
  });

  it("surfaces a Correctness violation in the headline instead of burying it", () => {
    const bad = mk("c2-app-sigkill-naive-hammer-seat-rep1", { args: { fault: "app-sigkill" }, correctnessViolation: true });
    const doc = renderExhibitH({ reports: [load(bad), load(mk("c2-app-sigkill-naive-hammer-seat-rep2", { args: { fault: "app-sigkill" } }))], unitControls: null });
    expect(doc).toContain("**Correctness violations** in measured runs (any Oracle failing) | **1** (c2-app-sigkill-naive-hammer-seat-rep1)");
  });

  it("does not count a flagged negative control as a Correctness violation, and reports an unflagged one", () => {
    const flagged = mk("c2ctl-a", { args: { expectViolations: true }, correctnessViolation: true });
    const unflagged = mk("c2ctl-b", { args: { expectViolations: true }, correctnessViolation: false });
    const doc = renderExhibitH({ reports: [load(flagged), load(unflagged), load(mk("c2-latency-below-naive-hammer-seat-rep1", { args: { fault: "latency-below" } }))], unitControls: null });
    expect(doc).toContain("| **Correctness violations** in measured runs (any Oracle failing) | **0** |");
    expect(doc).toContain("**1 of 2** end-to-end");
  });
});

describe("checkRecordClaims", () => {
  it("flags a DIFF when a record's number is not what the reports say", () => {
    // Zero scaffolded C1 runs here, but the C1 record quotes 6.
    const rows = checkRecordClaims([load(mk("unmodified-kill-rep1", { args: { fault: "backend-kill" } }))]);
    const scaffolded = rows.find((r) => r.claim === "scaffolded runs");
    expect(scaffolded).toMatchObject({ quoted: "6", computed: "0", match: false });
  });
});

describe("canonical finding numbering", () => {
  it("is one list, R1..R7, with C3's old R5 reconciled to R7 and C2's R5/R6 kept", () => {
    expect(CANONICAL_FINDINGS.map((f) => f.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
    const byId = Object.fromEntries(CANONICAL_FINDINGS.map((f) => [f.id, f]));
    expect(byId.R5!.title).toMatch(/advisory/);
    expect(byId.R6!.title).toMatch(/Retry loops/);
    expect(byId.R7!.title).toMatch(/reaper/i);
    expect(byId.R7!.oldNumbers).toContain("C3 R5");
  });
});

describe("formal-derived findings", () => {
  it("are numbered RF1..RF2, apart from the chaos-observed R1..R7, and cited rather than computed", () => {
    expect(FORMAL_FINDINGS.map((f) => f.id)).toEqual(["RF1", "RF2"]);
    expect(CANONICAL_FINDINGS.some((f) => f.id.startsWith("RF"))).toBe(false);
    const doc = renderExhibitH({ reports: [load(mk("c2-latency-below-naive-hammer-seat-rep1", { args: { fault: "latency-below" } }))], unitControls: null });
    expect(doc).toContain("### Formal-derived findings (RF1–RF2)");
    expect(doc).toContain("invisible to these runs by construction");
    for (const f of FORMAL_FINDINGS) expect(f.whyChaosMissesIt).toMatch(/stored state|Oracle/);
  });
});

describe("countUnitControls", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("counts it()/test() cases including skipIf-wrapped ones, and returns null for a missing directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "exhibit-h-"));
    await writeFile(join(dir, "a.test.ts"), `describe("x", () => {\n  it("one", () => {});\n  test("two", () => {});\n  it.skipIf(!ok)("three", () => {});\n});\n// it("not a test")\n`);
    const counts = await countUnitControls(new URL(`file://${dir}/`), ["a.test.ts"]);
    expect(counts).toEqual([{ file: "a.test.ts", tests: 3 }]);
    expect(await countUnitControls(new URL("file:///nonexistent-dir-for-exhibit-h/"), ["a.test.ts"])).toBeNull();
  });
});

describe("the committed chaos evidence", () => {
  it("shows zero Correctness violations in measured runs and every negative control flagged", async () => {
    const all = await loadChaosReports(chaosDir);
    expect(all.length).toBeGreaterThan(500);
    const measured = all.filter((x) => !x.report.args.expectViolations);
    const controls = all.filter((x) => x.report.args.expectViolations);
    expect(measured.filter((x) => x.report.correctnessViolation).map((x) => x.file)).toEqual([]);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.filter((x) => !x.report.correctnessViolation).map((x) => x.file)).toEqual([]);
  });

  it("classifies every report into a known group (nothing silently dropped)", async () => {
    const all = await loadChaosReports(chaosDir);
    const files = (await import("node:fs")).readdirSync(chaosDir).filter((f) => f.endsWith(".json"));
    expect(all.length).toBe(files.length);
  });

  it("reproduces C2's committed tables cell for cell", async () => {
    const all = await loadChaosReports(chaosDir);
    const doc = renderExhibitH({ reports: all, unitControls: null });
    const c2Record = await readFile(new URL("../docs/evidence/chaos-c2-fault-matrix.md", import.meta.url), "utf8");
    const mechRow = /^\| (naive|unique_constraint|pessimistic|optimistic|advisory|serializable) \| [✅❌]/;
    const rendered = doc.split("\n").filter((l) => mechRow.test(l));
    expect(rendered.length).toBe(7 * 6); // 5 unmodified + 2 scaffolded Fault tables x 6 mechanisms
    const record = new Set(c2Record.split("\n"));
    expect(rendered.filter((l) => !record.has(l))).toEqual([]);
  });

  it("recomputes the same per-Fault stall/drain digest C2 published", async () => {
    const all = await loadChaosReports(chaosDir);
    const doc = renderExhibitH({ reports: all, unitControls: null });
    const c2Record = await readFile(new URL("../docs/evidence/chaos-c2-fault-matrix.md", import.meta.url), "utf8");
    // Only the leading columns (Fault … transactions that never drained) are
    // formatted identically to C2's table; thousands separators differ.
    const lead = (l: string) => l.split("|").slice(1, 7).map((c) => c.trim()).join("|");
    const ours = doc.split("\n").filter((l) => /^\| (latency-below|latency-above|partition-stall|partition-reset|app-sigkill) \| 60 \|/.test(l));
    const theirs = c2Record.split("\n").filter((l) => /^\| (latency-below|latency-above|partition-stall|partition-reset|app-sigkill) \| 60 \|/.test(l));
    expect(ours.length).toBe(7);
    expect(ours.map(lead)).toEqual(theirs.map(lead));
  });

  it("separates the R5 advisory signature from scaffold-induced 500s", async () => {
    const ev = computeFindingEvidence(await loadChaosReports(chaosDir));
    expect(ev.r5.matrixHits).toEqual(["c2-partition-stall-advisory-hammer-seat-rep1"]);
    expect(ev.r5.noFault500).toBe(0);
  });

  it("matches the committed docs/evidence/exhibit-h-phase6-chaos.md (regenerate with --exhibit h)", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "exhibit-h-out-")), "exhibit-h.md");
    execFileSync("npx", ["tsx", "load-harness/aggregate.ts", "--exhibit", "h", "--out", out], { cwd: repoRoot, stdio: "pipe" });
    const regenerated = await readFile(out, "utf8");
    const committed = await readFile(new URL("../docs/evidence/exhibit-h-phase6-chaos.md", import.meta.url), "utf8");
    expect(regenerated).toBe(committed);
    await rm(join(out, ".."), { recursive: true, force: true });
  }, 60_000);

  it("leaves the default (Exhibit C) output byte-identical to the committed document", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "exhibit-c-out-")), "exhibit-c.md");
    execFileSync("npx", ["tsx", "load-harness/aggregate.ts", "--out", out], { cwd: repoRoot, stdio: "pipe" });
    const regenerated = await readFile(out, "utf8");
    const committed = await readFile(new URL("../docs/evidence/exhibit-c-phase2-comparison.md", import.meta.url), "utf8");
    expect(regenerated).toBe(committed);
    await rm(join(out, ".."), { recursive: true, force: true });
  }, 60_000);
});
