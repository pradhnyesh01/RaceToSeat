// Tests for the Phase 8 chart generator (issue #74, W2).
//
// The seam under test is a pure function: report-derived data in, SVG text out.
// No browser, no visual diff, no database. What a good test checks here is what
// a reader relies on — the key numbers are on the chart, the labels and units
// are the exhibit tables' own, two calls are byte-identical, and the marks are
// distinguishable without color. How the SVG is assembled is not asserted.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CHART_FILES,
  renderCharts,
  type ChartData,
  type ChaosCell,
  type ComparisonPoint,
  type IsolationPoint,
} from "../load-harness/chartsRender.js";
import { buildCharts } from "../load-harness/charts.js";

const MECHANISMS = ["naive", "unique_constraint", "pessimistic", "optimistic", "advisory", "serializable"];
const LOADS: Pick<ComparisonPoint, "pattern" | "concurrency">[] = [
  { pattern: "hammer-seat", concurrency: 10 },
  { pattern: "hammer-seat", concurrency: 100 },
  { pattern: "hammer-seat", concurrency: 1000 },
  { pattern: "spread-seats", concurrency: 1000 },
];

function comparison(): ComparisonPoint[] {
  return MECHANISMS.flatMap((mechanism, m) =>
    LOADS.map((load, l) => ({
      mechanism,
      ...load,
      throughputRps: 1000 + m * 111.11 + l * 7.77,
      p99Ms: 20 + m * 3.33 + l * 1.11,
    })),
  );
}

function isolation(): IsolationPoint[] {
  return [
    { mechanism: "naive", degradation: 0.052 },
    { mechanism: "unique_constraint", degradation: -0.027 },
    { mechanism: "pessimistic", degradation: -0.136 },
    { mechanism: "optimistic", degradation: 0.601 },
    { mechanism: "advisory", degradation: 0.0994 },
    { mechanism: "serializable", degradation: 0.1 },
  ];
}

function chaos(): ChaosCell[] {
  const faults = ["latency-below", "latency-above", "partition-stall", "partition-reset", "app-sigkill"];
  return MECHANISMS.flatMap((mechanism) =>
    faults.map((fault) => ({ mechanism, fault, variant: "unmodified" as const, clean: 10, runs: 10, crashed: 4 })),
  );
}

function fixture(): ChartData {
  return {
    comparison: comparison(),
    deadlock: {
      before: [
        { requests: 3000, deadlocks: 4 },
        { requests: 3000, deadlocks: 3 },
        { requests: 3000, deadlocks: 1 },
      ],
      after: [
        { requests: 3000, deadlocks: 0 },
        { requests: 3000, deadlocks: 0 },
        { requests: 3000, deadlocks: 0 },
      ],
      anyDoubleBooked: false,
    },
    isolation: isolation(),
    chaos: chaos(),
  };
}

const FILES = Object.values(CHART_FILES);

// A minimal well-formedness check, standing in for an XML parser: every tag's attributes are
// unique and every opened element is closed in order. An SVG that a browser refuses to render
// (a repeated attribute, an unclosed tag) would otherwise pass every string assertion.
function wellFormedProblems(svg: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g)) {
    const [, closing, name, attrs, selfClosing] = m;
    if (closing) {
      if (stack.pop() !== name) problems.push(`unbalanced </${name}>`);
      continue;
    }
    const names = [...attrs!.matchAll(/\s([\w:-]+)=/g)].map((a) => a[1]!);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) problems.push(`<${name}> repeats attribute ${dupes.join(", ")}`);
    if (!selfClosing) stack.push(name!);
  }
  if (stack.length) problems.push(`unclosed: ${stack.join(", ")}`);
  return problems;
}

describe("renderCharts", () => {
  it("produces exactly the four charts, each a standalone SVG document", () => {
    const out = renderCharts(fixture());
    expect(Object.keys(out).sort()).toEqual([...FILES].sort());
    expect(FILES).toHaveLength(4);
    for (const svg of Object.values(out)) {
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg.endsWith("</svg>\n")).toBe(true);
      expect(svg).toContain("<title");
      // Nothing computed leaked through as a non-number.
      expect(svg).not.toMatch(/NaN|undefined|Infinity|null/);
    }
  });

  it("is well-formed XML: no repeated attribute, no unclosed element", () => {
    for (const [name, svg] of Object.entries(renderCharts(fixture()))) {
      expect({ name, problems: wellFormedProblems(svg) }).toEqual({ name, problems: [] });
    }
  });

  it("is well-formed over the committed reports too", async () => {
    for (const [name, svg] of Object.entries(await buildCharts())) {
      expect({ name, problems: wellFormedProblems(svg) }).toEqual({ name, problems: [] });
    }
  });

  it("is byte-identical across two calls, and independent of input order", () => {
    const a = renderCharts(fixture());
    const b = renderCharts(fixture());
    expect(b).toEqual(a);

    const shuffled = fixture();
    shuffled.comparison.reverse();
    shuffled.isolation.reverse();
    shuffled.chaos.reverse();
    expect(renderCharts(shuffled)).toEqual(a);
  });

  it("carries no timestamp or environment-dependent text", () => {
    for (const svg of Object.values(renderCharts(fixture()))) {
      expect(svg).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/);
      expect(svg).not.toMatch(/\/Users\//);
    }
  });

  describe("chart 1 — throughput and p99 by Mechanism and load level (Exhibit C)", () => {
    const svg = () => renderCharts(fixture())[CHART_FILES.comparison]!;

    it("shows each key number with the exhibit table's precision and units", () => {
      const s = svg();
      // Exhibit C prints throughput and p99 with one decimal (`toFixed(1)`).
      expect(s).toContain((1000 + 2 * 111.11 + 2 * 7.77).toFixed(1));
      expect(s).toContain((20 + 3 * 3.33 + 3 * 1.11).toFixed(1));
      expect(s).toContain("Throughput (req/s)");
      expect(s).toContain("p99 (ms)");
    });

    it("names every Mechanism and load level as the exhibit table does", () => {
      const s = svg();
      for (const m of MECHANISMS) expect(s).toContain(m);
      for (const l of ["hammer-seat 10", "hammer-seat 100", "hammer-seat 1000", "spread-seats 1000"]) {
        expect(s).toContain(l);
      }
    });

    it('labels the Control\'s rows "Control, with Backstop", and no Mechanism\'s', () => {
      const s = svg();
      expect(s).toMatch(/naive[^<]*Control, with Backstop/);
      expect(s.match(/Control, with Backstop/g)!.length).toBeGreaterThanOrEqual(1);
      expect(s).not.toMatch(/unique_constraint[^<]*Control/);
      expect(s).not.toMatch(/pessimistic[^<]*Control/);
    });

    it("distinguishes the six series by fill pattern, not by color alone", () => {
      const s = svg();
      const patterns = new Set([...s.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]));
      // Six series: at least five hatch patterns (the sixth may be a plain fill).
      expect(patterns.size).toBeGreaterThanOrEqual(5);
      // Every series' legend swatch references its own fill, and no two are the same.
      const legendFills = [...s.matchAll(/data-series="([^"]+)" fill="([^"]+)"/g)];
      expect(new Set(legendFills.map((m) => m[1])).size).toBe(6);
      expect(new Set(legendFills.map((m) => m[2])).size).toBe(6);
    });
  });

  describe("chart 2 — deadlocks before and after the lock-ordering fix (Exhibit D)", () => {
    const svg = () => renderCharts(fixture())[CHART_FILES.deadlock]!;

    it("shows the per-repeat counts and the 8-per-9,000 headline", () => {
      const s = svg();
      expect(s).toContain("Deadlocks / 9,000 requests");
      expect(s).toMatch(/Before[^<]*\b8 deadlocks/);
      expect(s).toMatch(/After[^<]*\b0 deadlocks/);
      for (const n of ["4", "3", "1"]) expect(s).toContain(`>${n}<`);
      expect(s).toContain("Repeat 1");
      expect(s).toContain("Repeat 3");
    });

    it("totals from the data, not from a constant", () => {
      const data = fixture();
      data.deadlock.before = [
        { requests: 1000, deadlocks: 2 },
        { requests: 1000, deadlocks: 5 },
      ];
      const s = renderCharts(data)[CHART_FILES.deadlock]!;
      expect(s).toContain("Deadlocks / 2,000 requests");
      expect(s).toMatch(/Before[^<]*\b7 deadlocks/);
    });

    it("keeps a zero visible instead of drawing nothing", () => {
      const s = svg();
      expect(s.match(/>0</g)!.length).toBeGreaterThanOrEqual(3);
    });

    it("distinguishes Before from After by fill pattern as well as by label", () => {
      const s = svg();
      const before = s.match(/data-series="before" fill="([^"]+)"/)![1];
      const after = s.match(/data-series="after" fill="([^"]+)"/)![1];
      expect(before).not.toBe(after);
    });
  });

  describe("chart 3 — cross-seat isolation degradation against the 10% threshold (Exhibit E)", () => {
    const svg = () => renderCharts(fixture())[CHART_FILES.isolation]!;

    it("prints each Mechanism's degradation in the exhibit table's signed format", () => {
      const s = svg();
      expect(s).toContain("+60.1%");
      expect(s).toContain("-13.6%");
      expect(s).toContain("+5.2%");
      expect(s).toContain("-2.7%");
    });

    it("draws and names the 10% threshold, and states pass or fail in words", () => {
      const s = svg();
      expect(s).toMatch(/10% threshold/);
      expect(s).toContain("PASS");
      expect(s).toContain("FAIL");
    });

    it("treats exactly 10.0% as failing, as the exhibit does (strictly under 10% passes)", () => {
      const s = svg();
      const row = (name: string) => s.match(new RegExp(`data-mechanism="${name}" data-verdict="(PASS|FAIL)"`))![1];
      expect(row("advisory")).toBe("PASS"); // 9.94%
      expect(row("serializable")).toBe("FAIL"); // 10.0%
      expect(row("optimistic")).toBe("FAIL");
      expect(row("pessimistic")).toBe("PASS");
    });

    it("marks passing and failing bars with different fill patterns, not only color", () => {
      const s = svg();
      const pass = s.match(/data-mechanism="pessimistic" data-verdict="PASS"[^>]* fill="([^"]+)"/)![1];
      const fail = s.match(/data-mechanism="optimistic" data-verdict="FAIL"[^>]* fill="([^"]+)"/)![1];
      expect(pass).not.toBe(fail);
    });

    it("shows a mechanism with no measurement as missing, not as zero", () => {
      const data = fixture();
      data.isolation[1] = { mechanism: "unique_constraint", degradation: null };
      const s = renderCharts(data)[CHART_FILES.isolation]!;
      expect(s).toMatch(/data-mechanism="unique_constraint" data-verdict="missing data"/);
    });
  });

  describe("chart 4 — Oracle results across the chaos matrix (Exhibit H)", () => {
    const svg = () => renderCharts(fixture())[CHART_FILES.chaos]!;

    it("shows Oracle-clean runs over total runs per Mechanism and Fault, and the rollup", () => {
      const s = svg();
      expect(s).toContain("Oracle-clean runs/total");
      expect(s).toContain("10/10");
      // Rollup across the five Faults, as Exhibit H's A2 table: 50/50 per Mechanism.
      expect(s).toContain("50/50");
      for (const f of ["latency-below", "latency-above", "partition-stall", "partition-reset", "app-sigkill"]) {
        expect(s).toContain(f);
      }
      for (const m of MECHANISMS) expect(s).toContain(m);
    });

    it("says a cell with a Correctness violation is not clean, in a glyph and not only a color", () => {
      const data = fixture();
      data.chaos[0] = { ...data.chaos[0]!, clean: 9 };
      const s = renderCharts(data)[CHART_FILES.chaos]!;
      expect(s).toContain("9/10");
      expect(s).toContain("✗");
      expect(s).toContain("✓");
      expect(renderCharts(fixture())[CHART_FILES.chaos]).not.toContain("✗");
    });

    it("keeps the unmodified and the scaffolded runs apart, never merged", () => {
      const data = fixture();
      data.chaos.push(
        ...MECHANISMS.flatMap((mechanism) =>
          ["partition-stall", "partition-reset"].map((fault) => ({
            mechanism,
            fault,
            variant: "scaffolded" as const,
            clean: 10,
            runs: 10,
            crashed: 0,
          })),
        ),
      );
      const s = renderCharts(data)[CHART_FILES.chaos]!;
      expect(s).toMatch(/Unmodified code/);
      expect(s).toMatch(/--survive-uncaught/);
      // 60 + 20 scaffolded runs are never summed into one cell.
      expect(s).not.toContain("70/70");
      expect(s).not.toContain("60/60");
    });

    it("states how many runs the application process exited in, from the data (not 'most')", () => {
      const s = renderCharts(fixture())[CHART_FILES.chaos]!;
      // 6 Mechanisms x 5 Faults x crashed 4 of 10.
      expect(s).toContain("exited in 120 of 300 runs");
      expect(s).not.toMatch(/Most runs/);
    });

    it('labels the Control "naive" as running with the Backstop', () => {
      expect(svg()).toMatch(/naive[^<]*Control, with Backstop/);
    });
  });
});

describe("buildCharts over the committed reports", () => {
  // These read the repository's own committed evidence (no database): the charts'
  // numbers must be the ones the exhibit tables print, so a reader can cross-reference.
  it("regenerates all four charts, byte-identically across two runs", async () => {
    const a = await buildCharts();
    const b = await buildCharts();
    expect(Object.keys(a).sort()).toEqual([...FILES].sort());
    expect(b).toEqual(a);
  });

  it("prints the isolation degradations Exhibit E prints", async () => {
    const svg = (await buildCharts())[CHART_FILES.isolation]!;
    const exhibit = await readFile(new URL("../docs/evidence/exhibit-e-phase4-isolation.md", import.meta.url), "utf8");
    const table = exhibit.split("\n").filter((l) => /^\| `(naive|unique_constraint|pessimistic|optimistic|advisory|serializable)` \|/.test(l));
    expect(table.length).toBeGreaterThanOrEqual(6);
    for (const row of table.slice(0, 6)) {
      const cells = row.split("|").map((c) => c.trim());
      const degradation = cells[5]!; // Mechanism | Repeats | Baseline | Combined | Degradation
      expect(degradation).toMatch(/^[+-]\d+\.\d%$/);
      expect(svg).toContain(degradation);
    }
  });

  it("prints the throughput and p99 Exhibit C prints", async () => {
    const svg = (await buildCharts())[CHART_FILES.comparison]!;
    const exhibit = await readFile(new URL("../docs/evidence/exhibit-c-phase2-comparison.md", import.meta.url), "utf8");
    const rows = exhibit.split("\n").filter((l) => /^\| `(naive|unique_constraint|pessimistic|optimistic|advisory|serializable)` \| (hammer-seat|spread-seats) \|/.test(l));
    expect(rows).toHaveLength(24);
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      // | Mechanism | Pattern | Concurrency | Repeats | Requests | Throughput | p50 | p99 |
      expect(svg).toContain(cells[6]!);
      expect(svg).toContain(cells[8]!);
    }
  });

  it("prints Exhibit D's before/after deadlock counts", async () => {
    const svg = (await buildCharts())[CHART_FILES.deadlock]!;
    expect(svg).toContain("Deadlocks / 9,000 requests");
    expect(svg).toMatch(/Before[^<]*\b8 deadlocks/);
    expect(svg).toMatch(/After[^<]*\b0 deadlocks/);
  });

  it("prints Exhibit H's per-Mechanism Oracle-clean rollups (50/50 unmodified, 20/20 scaffolded)", async () => {
    const svg = (await buildCharts())[CHART_FILES.chaos]!;
    const exhibit = await readFile(new URL("../docs/evidence/exhibit-h-phase6-chaos.md", import.meta.url), "utf8");
    const a2 = exhibit.split("#### A3.")[0]!.split("#### A2.")[1]!;
    const b2 = exhibit.split("#### B3.")[0]!.split("#### B2.")[1]!;
    for (const section of [a2, b2]) {
      const rollups = section.split("\n").filter((l) => /^\| `/.test(l)).map((l) => l.split("|").map((c) => c.trim())[3]!);
      expect(rollups).toHaveLength(6);
      for (const r of rollups) expect(svg).toContain(r);
    }
  });
});
