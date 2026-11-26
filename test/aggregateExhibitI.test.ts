// Tests for `aggregate.ts --exhibit i` (issue #73, Phase 8 W1) and
// load-harness/exhibitI.ts.
//
// Exhibit I asks what each Mechanism does when the Backstop (the shared
// UNIQUE(seat_id), ADR-0008) is removed. The seam under test is the rendered
// exhibit: per-run chaos reports go in, Markdown comes out. No database and no
// load run is needed — fixtures stand in for reports, as in the Exhibit H test.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseExhibit, parseOutPath } from "../load-harness/aggregate.js";
import { loadExhibitIReports, renderExhibitI, type ExhibitIReport, type LoadedExhibitIReport } from "../load-harness/exhibitI.js";

const PASS_ORACLES = [1, 2, 3, 4].map((n) => ({ oracle: n, name: `oracle ${n}`, passed: true, violations: [] }));

type Over = Omit<Partial<ExhibitIReport>, "args"> & { args?: Partial<ExhibitIReport["args"]> };

// One run that held: exactly one winner of one contested seat, every Oracle green.
function measured(report: ExhibitIReport): LoadedExhibitIReport {
  return { file: `${report.label}.json`, report, kind: "measured" };
}

function mk(label: string, over: Over = {}): ExhibitIReport {
  const { args, ...rest } = over;
  return {
    label,
    ranAt: "2026-11-26T00:00:00.000Z",
    args: { strategy: "pessimistic", load: "hammer-seat", fault: "none", db: "scratch-no-unique", concurrency: 60, ...args },
    oracles: PASS_ORACLES,
    correctnessViolation: false,
    requestsIssued: 60,
    k6: { statusTally: { "201": 1, "409": 59 } },
    ambiguity: { bookingsCommittedBeforeReplay: 1 },
    ...rest,
  };
}

describe("renderExhibitI", () => {
  it("reports a Mechanism whose every repeat held as standing alone without the Backstop", () => {
    const reports = [1, 2, 3].map((rep) => mk(`w1-pessimistic-hammer-seat-rep${rep}`));
    const doc = renderExhibitI(reports.map(measured));

    const row = doc.split("\n").find((line) => line.startsWith("| `pessimistic` | hammer-seat"));
    expect(row).toBeDefined();
    expect(row).toContain("held 3/3");
    expect(row).not.toContain("double-booked");
    expect(row).not.toContain("inoperative");
  });

  it("does not count a run that booked nothing as a pass, even though every Oracle is green", () => {
    // Observed in the smoke run: with the Backstop gone, `ON CONFLICT (seat_id)` has no
    // arbiter index, every insert fails (HTTP 500), the database stays empty, and the
    // Oracles pass vacuously.
    const failedClosed = mk("w1-unique_constraint-hammer-seat-rep1", {
      args: { strategy: "unique_constraint" },
      k6: { statusTally: { "500": 60 } },
      ambiguity: { bookingsCommittedBeforeReplay: 0 },
    });
    const doc = renderExhibitI([measured(failedClosed)]);

    const row = doc.split("\n").find((line) => line.startsWith("| `unique_constraint` | hammer-seat"));
    expect(row).toContain("inoperative 1/1");
    expect(row).not.toContain("held");
  });

  it("reports a Mechanism that double-books without the Backstop, with how many Bookings claimed the Seat", () => {
    const doubleBooked = mk("w1-naive-hammer-seat-rep1", {
      args: { strategy: "naive" },
      oracles: [
        { oracle: 1, name: "mutual exclusion", passed: false, violations: [{ kind: "seat-claimed-twice", detail: "one seat is claimed by 13 bookings" }] },
        ...PASS_ORACLES.slice(1),
      ],
      correctnessViolation: true,
      k6: { statusTally: { "201": 13, "409": 47 } },
      ambiguity: { bookingsCommittedBeforeReplay: 13 },
    });
    const doc = renderExhibitI([measured(doubleBooked)]);

    const row = doc.split("\n").find((line) => line.startsWith("| `naive` | hammer-seat"));
    expect(row).toContain("double-booked 1/1");
    expect(row).toContain("13 bookings");
  });

  it("lists a Mechanism with no runs as not run, instead of leaving it out", () => {
    const only = mk("w1-pessimistic-hammer-seat-rep1");
    const doc = renderExhibitI([measured(only)]);

    for (const mechanism of ["unique_constraint", "optimistic", "advisory", "serializable"]) {
      const row = doc.split("\n").find((line) => line.startsWith(`| \`${mechanism}\` | hammer-seat`));
      expect(row, mechanism).toContain("not run");
    }
  });
});

describe("renderExhibitI predictions", () => {
  // The spec (issue #72) predicted, before any measured run: `unique_constraint` and the
  // Control double-book without the Backstop; the other four hold.
  it("marks a prediction missed when the observed outcome is a different kind of failure", () => {
    const failedClosed = mk("w1-unique_constraint-hammer-seat-rep1", {
      args: { strategy: "unique_constraint" },
      k6: { statusTally: { "500": 60 } },
      ambiguity: { bookingsCommittedBeforeReplay: 0 },
    });
    const doc = renderExhibitI([measured(failedClosed)]);

    const row = doc.split("\n").find((line) => line.startsWith("| `unique_constraint` | hammer-seat"));
    expect(row).toContain("double-booked");
    expect(row).toContain("prediction missed");
  });

  it("marks a prediction as held up when the observed outcome matches it", () => {
    const held = mk("w1-pessimistic-hammer-seat-rep1");
    const doc = renderExhibitI([measured(held)]);

    const row = doc.split("\n").find((line) => line.startsWith("| `pessimistic` | hammer-seat"));
    expect(row).toContain("as predicted");
  });
});

describe("--exhibit i wiring", () => {
  it("accepts i and writes exhibit-i-phase8-no-backstop.md by default", () => {
    expect(parseExhibit(["--exhibit", "i"])).toBe("i");
    expect(parseOutPath(["--exhibit", "i"], "i")).toMatch(/docs\/evidence\/exhibit-i-phase8-no-backstop\.md$/);
  });

  it("still defaults to Exhibit C and rejects unknown exhibits", () => {
    expect(parseExhibit([])).toBe("c");
    expect(() => parseExhibit(["--exhibit", "z"])).toThrow(/"i"/);
  });
});

describe("loadExhibitIReports", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("loads every chaos report and classifies it as measured, smoke or probe; ignores app logs and other files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exhibit-i-"));
    dirs.push(dir);
    const stamp = "2026-11-26T00-00-00-000Z";
    await writeFile(join(dir, `w1-pessimistic-hammer-seat-rep1-${stamp}.json`), JSON.stringify(mk("w1-pessimistic-hammer-seat-rep1")));
    await writeFile(join(dir, `w1-smoke-unique_constraint-hammer-seat-${stamp}.json`), JSON.stringify(mk("w1-smoke-unique_constraint-hammer-seat")));
    await writeFile(join(dir, `w1-smoke-probe-1000-naive-hammer-seat-${stamp}.json`), JSON.stringify(mk("w1-smoke-probe-1000-naive-hammer-seat")));
    await writeFile(join(dir, `w1-pessimistic-hammer-seat-rep1-${stamp}.app.log`), "listening\n");
    await writeFile(join(dir, "notes.json"), JSON.stringify({ hello: "world" }));

    const loaded = await loadExhibitIReports(pathToFileURL(dir + "/"));

    expect(loaded.map((l) => [l.report.label, l.kind])).toEqual([
      ["w1-pessimistic-hammer-seat-rep1", "measured"],
      ["w1-smoke-probe-1000-naive-hammer-seat", "probe"],
      ["w1-smoke-unique_constraint-hammer-seat", "smoke"],
    ]);
  });

  it("returns nothing for a directory that does not exist yet", async () => {
    expect(await loadExhibitIReports(pathToFileURL(join(tmpdir(), "exhibit-i-does-not-exist") + "/"))).toEqual([]);
  });
});

describe("renderExhibitI document", () => {
  const stamp = "2026-11-26T00-00-00-000Z";
  const everything = (): LoadedExhibitIReport[] => {
    const out: LoadedExhibitIReport[] = [];
    for (let rep = 1; rep <= 3; rep += 1) {
      out.push(measured(mk(`w1-pessimistic-hammer-seat-rep${rep}`)));
      // serializable on overlapping pairs: nothing double-booked, but only 18 of 30 pairs booked
      out.push(
        measured(
          mk(`w1-serializable-deadlock-pairs-rep${rep}`, {
            args: { strategy: "serializable", load: "deadlock-pairs", concurrency: 30 },
            k6: { statusTally: { "201": 18, "409": 13, "503": 29 } },
            ambiguity: { bookingsCommittedBeforeReplay: 18 },
          }),
        ),
      );
      out.push(
        measured(
          mk(`w1-naive-hammer-seat-rep${rep}`, {
            args: { strategy: "naive" },
            oracles: [{ oracle: 1, name: "mutual exclusion", passed: false, violations: [{ kind: "seat-in-multiple-bookings", detail: "seat s is claimed by 9 bookings" }] }, ...PASS_ORACLES.slice(1)],
            correctnessViolation: true,
            ambiguity: { bookingsCommittedBeforeReplay: 9 },
          }),
        ),
      );
    }
    return out;
  };

  it("shows Bookings created against expected, so an underfilled cell is not hidden behind 'held'", () => {
    const doc = renderExhibitI(everything());
    const row = doc.split("\n").find((line) => line.startsWith("| `serializable` | deadlock-pairs"));
    expect(row).toContain("held 3/3");
    expect(row).toContain("54/90");
  });

  it("states the detector check: how often the Control was flagged", () => {
    const doc = renderExhibitI(everything());
    expect(doc).toContain("Control flagged in 3 of 3 runs");
  });

  it("states how many runs of the coordinated Mechanisms held", () => {
    const doc = renderExhibitI(everything());
    expect(doc).toMatch(/held in 6 of 6 measured runs/);
  });

  it("documents the concurrency ceiling from the probe run, when one is present", () => {
    const probe = mk("w1-smoke-probe-1000-naive-hammer-seat", {
      args: { strategy: "naive", concurrency: 1000 },
      requestsIssued: 1000,
      k6: { statusTally: { "0": 606, "201": 3, "409": 391 } },
    });
    const doc = renderExhibitI([...everything(), { file: `${probe.label}-${stamp}.json`, report: probe, kind: "probe" }]);
    expect(doc).toContain("606 of 1000");
  });

  it("lists the smoke runs", () => {
    const smoke = mk("w1-smoke-unique_constraint-hammer-seat", {
      args: { strategy: "unique_constraint" },
      k6: { statusTally: { "500": 60 } },
      ambiguity: { bookingsCommittedBeforeReplay: 0 },
    });
    const doc = renderExhibitI([...everything(), { file: `${smoke.label}-${stamp}.json`, report: smoke, kind: "smoke" }]);
    expect(doc).toMatch(/\| `unique_constraint` \| hammer-seat \| .*500/);
    expect(doc).toContain("Smoke runs");
  });

  it("is a pure function of the reports: two renders are identical", () => {
    expect(renderExhibitI(everything())).toBe(renderExhibitI(everything()));
  });
});

describe("the committed Exhibit I", () => {
  // What makes the committed document a *regenerated* artifact, like Exhibits C/E/F/H: change a
  // report (or the renderer) without re-running `npm run harness:aggregate -- --exhibit i` and this fails.
  it("matches the committed docs/evidence/exhibit-i-phase8-no-backstop.md (regenerate with --exhibit i)", async () => {
    const loaded = await loadExhibitIReports(new URL("../docs/evidence/exhibit-i/", import.meta.url));
    const committed = await readFile(new URL("../docs/evidence/exhibit-i-phase8-no-backstop.md", import.meta.url), "utf8");
    expect(renderExhibitI(loaded)).toBe(committed);
  });

  it("covers every strategy and workload with 3 measured repeats, plus smoke runs and the concurrency probe", async () => {
    const loaded = await loadExhibitIReports(new URL("../docs/evidence/exhibit-i/", import.meta.url));
    const measured = loaded.filter((l) => l.kind === "measured");
    for (const strategy of ["naive", "unique_constraint", "pessimistic", "optimistic", "advisory", "serializable"]) {
      for (const load of ["hammer-seat", "deadlock-pairs"]) {
        expect(measured.filter((l) => l.report.args.strategy === strategy && l.report.args.load === load), `${strategy} x ${load}`).toHaveLength(3);
      }
    }
    expect(loaded.filter((l) => l.kind === "smoke")).toHaveLength(12);
    expect(loaded.filter((l) => l.kind === "probe")).toHaveLength(1);
    // Every measured run is a no-Fault run on the Backstop-free database: the premise of the exhibit.
    for (const { report } of measured) {
      expect(report.args.db, report.label).toBe("scratch-no-unique");
      expect(report.args.fault, report.label).toBe("none");
    }
  });
});
