// Drift guard for the spec-action -> SQL mapping in docs/evidence/exhibit-g-phase6-formal.md
// (issue #48, F5).
//
// The mapping is hand-audited, not trace-validated (ADR-0021): nothing proves the TLA+
// actions in formal/ describe what src/ really does except a person reading both. What this
// test adds is the part a machine *can* check: that the table the audit produced still points
// at real code. It parses the table out of the exhibit itself (so the document and the test
// cannot disagree), and for every row asserts
//
//   1. the cited file exists,
//   2. the row's literal anchor snippet still appears in that file  -> if not, the code the
//      row describes was rewritten or renamed: re-audit the row, do not just edit the snippet,
//   3. the snippet appears within LINE_TOLERANCE lines of the cited line(s) -> if not, the
//      code only moved: update the line number in the table,
//
// and, for coverage, that every action in each spec's `Next` has a mapping row and every
// `Module.Action` named in the table still exists in that module. A new spec action with no
// mapping row, or a renamed one, fails here rather than silently leaving the table stale.
//
// No database: it only reads files.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXHIBIT = "docs/evidence/exhibit-g-phase6-formal.md";
const MODULES = ["SeatBooking", "DeadlockFreedom", "SeatLifecycle", "CrashRecovery"] as const;

// How far from the cited line the anchor may sit before the row counts as drifted. Tight
// enough that "the line number is still meaningful", loose enough that a comment added above
// the statement does not fail the build.
const LINE_TOLERANCE = 4;

interface MappingRow {
  /** 1-based line of the row in the exhibit, for error messages. */
  exhibitLine: number;
  action: string;
  file: string;
  from: number;
  to: number;
  anchor: string;
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

// Rows between the two markers. Columns: Spec action | Code (`file:line`) | Anchor (`literal`) | notes.
// A row whose Code cell is a dash is a spec action with no production counterpart (an
// environment event or a negative-control mutation); it is covered but has nothing to anchor.
function parseMappingRows(markdown: string): { rows: MappingRow[]; noCode: { action: string }[] } {
  const lines = markdown.split("\n");
  const rows: MappingRow[] = [];
  const noCode: { action: string }[] = [];
  let inside = false;
  lines.forEach((line, i) => {
    if (line.includes("<!-- mapping:begin -->")) inside = true;
    else if (line.includes("<!-- mapping:end -->")) inside = false;
    else if (inside && line.startsWith("|") && !/^\|\s*-/.test(line) && !/^\|\s*Spec action/.test(line)) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      const [action = "", code = "", anchor = ""] = cells;
      if (code === "—") {
        noCode.push({ action });
        return;
      }
      const m = /^`([^`:]+):(\d+)(?:-(\d+))?`$/.exec(code);
      const a = /^`(.+)`$/.exec(anchor);
      if (!m || !a) {
        throw new Error(`${EXHIBIT}:${i + 1}: unparseable mapping row (code cell "${code}", anchor cell "${anchor}")`);
      }
      const from = Number(m[2]);
      rows.push({ exhibitLine: i + 1, action, file: m[1]!, from, to: m[3] ? Number(m[3]) : from, anchor: a[1]! });
    }
  });
  return { rows, noCode };
}

// The identifiers called in a module's `Next` (between `Next ==` and `Spec ==`), e.g.
// "Start", "AtomicClaim", "Crash". Terminated is a stutter, not an implementation step.
function nextActions(tla: string): string[] {
  const start = tla.search(/^Next ==/m);
  const end = tla.search(/^Spec ==/m);
  if (start < 0 || end < start) throw new Error("no Next/Spec block found");
  const block = tla.slice(start, end);
  return [...new Set([...block.matchAll(/\b([A-Z][A-Za-z]*)\(/g)].map((m) => m[1]!))];
}

// 1-based lines of `file` containing the row's anchor, and whether any is near the cited lines.
function locate(row: MappingRow): { hits: number[]; near: boolean } {
  const hits = read(row.file)
    .split("\n")
    .flatMap((l, i) => (l.includes(row.anchor) ? [i + 1] : []));
  return { hits, near: hits.some((n) => n >= row.from - LINE_TOLERANCE && n <= row.to + LINE_TOLERANCE) };
}

describe("formal spec <-> SQL mapping (exhibit G)", () => {
  const exhibit = read(EXHIBIT);
  const { rows, noCode } = parseMappingRows(exhibit);
  const allActions = [...rows.map((r) => r.action), ...noCode.map((r) => r.action)];

  it("parses a non-trivial table and pins it to a commit", () => {
    expect(rows.length).toBeGreaterThan(30);
    expect(exhibit).toMatch(/Audited at commit `[0-9a-f]{7,40}`/);
  });

  describe.each(rows)("$action -> $file:$from", (row) => {
    it("still contains its anchor snippet", () => {
      expect(
        locate(row).hits.length,
        `${EXHIBIT}:${row.exhibitLine}: anchor \`${row.anchor}\` is gone from ${row.file}. The code this row maps was ` +
          `changed: re-audit the row against the spec action, then update it.`,
      ).toBeGreaterThan(0);
    });

    it(`has the anchor within ${LINE_TOLERANCE} lines of the cited line`, () => {
      const { hits, near } = locate(row);
      expect(
        near,
        `${EXHIBIT}:${row.exhibitLine}: anchor \`${row.anchor}\` is at line(s) ${hits.join(", ") || "none"} of ${row.file}, ` +
          `not near the cited ${row.from}${row.to !== row.from ? `-${row.to}` : ""}. Update the line number in the table.`,
      ).toBe(true);
    });
  });

  describe.each(MODULES)("%s", (module) => {
    const tla = read(`formal/${module}.tla`);
    const hasRow = (action: string) =>
      allActions.some((cell) => new RegExp(`\\b${module}\\.${action}\\b`).test(cell));

    it("has a mapping row for every action in Next", () => {
      const missing = nextActions(tla).filter((a) => !hasRow(a));
      expect(missing, `${module}.tla has actions with no row in the mapping table`).toEqual([]);
    });

    it("names only actions that still exist in the spec", () => {
      const named = new Set<string>();
      for (const cell of allActions) {
        for (const m of cell.matchAll(new RegExp(`\\b${module}\\.([A-Za-z]+)\\b`, "g"))) named.add(m[1]!);
      }
      const undefinedNames = [...named].filter((n) => !new RegExp(`^${n}\\b.*==`, "m").test(tla));
      expect(undefinedNames, `table names ${module}.X for X not defined in ${module}.tla`).toEqual([]);
    });
  });

  // Negative controls for the checker itself (ADR-0023): the same locate() the real rows go through
  // must flag a doctored row, or a green run above would prove nothing.
  it("flags an anchor that is no longer in the file (the check can fail)", () => {
    const real = rows.find((r) => r.file === "src/strategies/pessimistic.ts")!;
    expect(locate(real).near).toBe(true);
    const doctored = { ...real, anchor: real.anchor.replace("NOWAIT", "SHARE NOWAIT") };
    expect(doctored.anchor).not.toBe(real.anchor);
    expect(locate(doctored).hits).toEqual([]);
  });

  it("flags a line number that has drifted (the check can fail)", () => {
    const real = rows.find((r) => r.file === "src/strategies/pessimistic.ts")!;
    const moved = { ...real, from: real.from + 100, to: real.to + 100 };
    const { hits, near } = locate(moved);
    expect(hits.length).toBeGreaterThan(0); // the anchor is still there...
    expect(near).toBe(false); // ...but not where the doctored row says
  });

  it("detects a spec action with no mapping row (the check can fail)", () => {
    const tla = read("formal/SeatBooking.tla").replace("\\/ Commit(r)", "\\/ Commit(r)\n         \\/ BrandNewAction(r)");
    const actions = nextActions(tla);
    expect(actions).toContain("BrandNewAction");
    expect(allActions.some((c) => /\bSeatBooking\.BrandNewAction\b/.test(c))).toBe(false);
  });
});
