// Tests for `aggregate.ts --exhibit i` (issue #73, Phase 8 W1) and
// load-harness/exhibitI.ts.
//
// Exhibit I asks what each Mechanism does when the Backstop (the shared
// UNIQUE(seat_id), ADR-0008) is removed. The seam under test is the rendered
// exhibit: per-run chaos reports go in, Markdown comes out. No database and no
// load run is needed — fixtures stand in for reports, as in the Exhibit H test.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseExhibit, parseOutPath } from "../load-harness/aggregate.js";
import { loadExhibitIReports, renderExhibitI, type ExhibitIReport } from "../load-harness/exhibitI.js";

const PASS_ORACLES = [1, 2, 3, 4].map((n) => ({ oracle: n, name: `oracle ${n}`, passed: true, violations: [] }));

type Over = Omit<Partial<ExhibitIReport>, "args"> & { args?: Partial<ExhibitIReport["args"]> };

// One run that held: exactly one winner of one contested seat, every Oracle green.
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
    const doc = renderExhibitI(reports.map((report) => ({ file: `${report.label}.json`, report })));

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
    const doc = renderExhibitI([{ file: `${failedClosed.label}.json`, report: failedClosed }]);

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
    const doc = renderExhibitI([{ file: `${doubleBooked.label}.json`, report: doubleBooked }]);

    const row = doc.split("\n").find((line) => line.startsWith("| `naive` | hammer-seat"));
    expect(row).toContain("double-booked 1/1");
    expect(row).toContain("13 bookings");
  });

  it("lists a Mechanism with no runs as not run, instead of leaving it out", () => {
    const only = mk("w1-pessimistic-hammer-seat-rep1");
    const doc = renderExhibitI([{ file: `${only.label}.json`, report: only }]);

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
    const doc = renderExhibitI([{ file: `${failedClosed.label}.json`, report: failedClosed }]);

    const row = doc.split("\n").find((line) => line.startsWith("| `unique_constraint` | hammer-seat"));
    expect(row).toContain("double-booked");
    expect(row).toContain("prediction missed");
  });

  it("marks a prediction as held up when the observed outcome matches it", () => {
    const held = mk("w1-pessimistic-hammer-seat-rep1");
    const doc = renderExhibitI([{ file: `${held.label}.json`, report: held }]);

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

  it("loads full-run reports, and skips smoke runs, app logs and files that are not chaos reports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exhibit-i-"));
    dirs.push(dir);
    const real = mk("w1-pessimistic-hammer-seat-rep1");
    const smoke = mk("w1-smoke-unique_constraint-hammer-seat");
    await writeFile(join(dir, "w1-pessimistic-hammer-seat-rep1-2026-11-26T00-00-00-000Z.json"), JSON.stringify(real));
    await writeFile(join(dir, "w1-smoke-unique_constraint-hammer-seat-2026-11-26T00-00-00-000Z.json"), JSON.stringify(smoke));
    await writeFile(join(dir, "w1-pessimistic-hammer-seat-rep1-2026-11-26T00-00-00-000Z.app.log"), "listening\n");
    await writeFile(join(dir, "notes.json"), JSON.stringify({ hello: "world" }));

    const loaded = await loadExhibitIReports(pathToFileURL(dir + "/"));

    expect(loaded.map((l) => l.report.label)).toEqual(["w1-pessimistic-hammer-seat-rep1"]);
  });

  it("returns nothing for a directory that does not exist yet", async () => {
    expect(await loadExhibitIReports(pathToFileURL(join(tmpdir(), "exhibit-i-does-not-exist") + "/"))).toEqual([]);
  });
});
