// Phase 8 chart generator, rendering half (issue #74, W2).
//
// A pure function from report-derived data to SVG text. It reads no files, has no clock, and
// never touches the environment, so two calls on the same data are byte-identical and a changed
// chart in a diff means changed data. Loading the committed reports into `ChartData` is
// charts.ts's job.
//
// Four charts, one per exhibit the writeup draws on. Each uses its exhibit table's own labels,
// units and number formats (shared with aggregate.ts where one exists) so a reader can
// cross-reference. Marks are distinguishable without color: each series has its own fill pattern,
// and a pass or a fail is a word and a glyph as well as a fill.
import { fmtPctSigned, NFR2_DEGRADATION_THRESHOLD, passesNfr2, STRATEGY_ORDER } from "./aggregate.js";
import { CONTROL } from "./exhibitI.js";

// ---------------------------------------------------------------------------
// Input shapes

export interface ComparisonPoint {
  mechanism: string;
  pattern: "hammer-seat" | "spread-seats";
  concurrency: number;
  throughputRps: number;
  p99Ms: number;
}

export interface DeadlockRun {
  requests: number;
  deadlocks: number;
}

export interface DeadlockData {
  before: DeadlockRun[];
  after: DeadlockRun[];
  /** True when any run in either set double-booked a Seat. */
  anyDoubleBooked: boolean;
}

export interface IsolationPoint {
  mechanism: string;
  /** (combined p99 - baseline p99) / baseline p99, as a fraction; null when a report is missing. */
  degradation: number | null;
}

export interface ChaosCell {
  mechanism: string;
  fault: string;
  variant: "unmodified" | "scaffolded";
  /** Runs in which every Oracle passed. */
  clean: number;
  runs: number;
  /** Runs in which the application process exited (Exhibit H's "app crashed"). */
  crashed: number;
}

export interface ChartData {
  comparison: ComparisonPoint[];
  deadlock: DeadlockData;
  isolation: IsolationPoint[];
  chaos: ChaosCell[];
}

export const CHART_FILES = {
  comparison: "comparison-throughput-p99.svg",
  deadlock: "deadlocks-before-after.svg",
  isolation: "isolation-degradation.svg",
  chaos: "chaos-oracle-matrix.svg",
} as const;

export function renderCharts(data: ChartData): Record<string, string> {
  return {
    [CHART_FILES.comparison]: renderComparison(data.comparison),
    [CHART_FILES.deadlock]: renderDeadlock(data.deadlock),
    [CHART_FILES.isolation]: renderIsolation(data.isolation),
    [CHART_FILES.chaos]: renderChaos(data.chaos),
  };
}

// ---------------------------------------------------------------------------
// Shared drawing helpers

const FONT = "Helvetica, Arial, sans-serif";
const INK = "#1a1a1a";
const MUTED = "#555555";
const GRID = "#d9d9d9";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// One decimal is plenty for pixel coordinates, and keeps the text short and stable.
function r(x: number): string {
  return String(Math.round(x * 10) / 10);
}

function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function sortedByMechanism<T extends { mechanism: string }>(items: T[]): T[] {
  const rank = (m: string) => {
    const i = STRATEGY_ORDER.indexOf(m);
    return i === -1 ? STRATEGY_ORDER.length : i;
  };
  return [...items].sort((a, b) => rank(a.mechanism) - rank(b.mechanism) || a.mechanism.localeCompare(b.mechanism));
}

function mechanismsOf(items: { mechanism: string }[]): string[] {
  return sortedByMechanism([...new Set(items.map((i) => i.mechanism))].map((mechanism) => ({ mechanism }))).map((m) => m.mechanism);
}

// The Control is not a Mechanism (CONTEXT.md): its rows say it ran on top of the Backstop.
function mechanismLabel(m: string): string {
  return m === CONTROL ? `${m} (Control, with Backstop)` : m;
}

function text(
  x: number,
  y: number,
  content: string,
  opts: { size?: number; anchor?: "start" | "middle" | "end"; weight?: "bold"; fill?: string; rotate?: number; attrs?: string } = {},
): string {
  const { size = 12, anchor = "start", weight, fill = INK, rotate, attrs = "" } = opts;
  const transform = rotate === undefined ? "" : ` transform="rotate(${rotate} ${r(x)} ${r(y)})"`;
  return `<text x="${r(x)}" y="${r(y)}" font-size="${size}" text-anchor="${anchor}" fill="${fill}"${weight ? ' font-weight="bold"' : ""}${transform}${attrs ? ` ${attrs}` : ""}>${esc(content)}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke = GRID, width = 1, dash = ""): string {
  return `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function svgDoc(width: number, height: number, title: string, desc: string, defs: string, body: string[]): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" role="img">\n` +
    `<title>${esc(title)}</title>\n` +
    `<desc>${esc(desc)}</desc>\n` +
    (defs ? `<defs>\n${defs}\n</defs>\n` : "") +
    `<rect width="${width}" height="${height}" fill="#ffffff"/>\n` +
    body.join("\n") +
    "\n</svg>\n"
  );
}

// "Nice" axis: a step of 1/2/2.5/5 x 10^k that covers `maxValue` in about `target` steps.
function niceScale(maxValue: number, target = 5): { max: number; step: number } {
  if (!(maxValue > 0)) return { max: 1, step: 0.2 };
  const raw = maxValue / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = mult * mag;
  return { max: Math.round(Math.ceil(maxValue / step - 1e-9) * step * 1e6) / 1e6, step };
}

function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; min + i * step <= max + 1e-9; i++) out.push(Math.round((min + i * step) * 1e6) / 1e6);
  return out;
}

function tickLabel(v: number): string {
  return Number.isInteger(v) ? thousands(v) : v.toFixed(1);
}

// ---------------------------------------------------------------------------
// Fill patterns: a series is told apart by its texture, with color as a second cue.

interface Texture {
  color: string;
  /** Pattern body drawn over the color, or null for a plain fill. */
  hatch: string | null;
  size: number;
}

// Okabe-Ito colors, each paired with a different texture.
const TEXTURES: Record<string, Texture> = {
  naive: {
    color: "#BDBDBD",
    size: 8,
    hatch: '<path d="M0 0L8 8M8 0L0 8" stroke="#333333" stroke-width="1"/>',
  },
  unique_constraint: {
    color: "#E69F00",
    size: 6,
    hatch: '<path d="M-1 7L7 -1M-1 1L1 -1M5 7L7 5" stroke="#000000" stroke-width="1.3"/>',
  },
  pessimistic: { color: "#0072B2", size: 0, hatch: null },
  optimistic: {
    color: "#D55E00",
    size: 6,
    hatch: '<circle cx="3" cy="3" r="1.4" fill="#ffffff"/>',
  },
  advisory: {
    color: "#009E73",
    size: 6,
    hatch: '<path d="M0 1.5H6M0 4.5H6" stroke="#ffffff" stroke-width="1.4"/>',
  },
  serializable: {
    color: "#CC79A7",
    size: 6,
    hatch: '<path d="M1.5 0V6M4.5 0V6" stroke="#333333" stroke-width="1.4"/>',
  },
};

const FALLBACK_TEXTURE: Texture = { color: "#888888", size: 0, hatch: null };

function textureFor(series: string): Texture {
  return TEXTURES[series] ?? FALLBACK_TEXTURE;
}

function patternId(series: string): string {
  return `pat-${series.replace(/[^a-z0-9]+/gi, "-")}`;
}

function patternDef(series: string, tex: Texture): string {
  if (tex.hatch === null) return "";
  return `<pattern id="${patternId(series)}" width="${tex.size}" height="${tex.size}" patternUnits="userSpaceOnUse"><rect width="${tex.size}" height="${tex.size}" fill="${tex.color}"/>${tex.hatch}</pattern>`;
}

function fillFor(series: string, tex: Texture = textureFor(series)): string {
  return tex.hatch === null ? tex.color : `url(#${patternId(series)})`;
}

// ---------------------------------------------------------------------------
// Chart 1 — throughput and p99 by Mechanism and load level (Exhibit C)

interface LoadLevel {
  pattern: ComparisonPoint["pattern"];
  concurrency: number;
  label: string;
}

function renderComparison(points: ComparisonPoint[]): string {
  const mechanisms = mechanismsOf(points);
  const levels: LoadLevel[] = [];
  for (const p of points) {
    if (!levels.some((l) => l.pattern === p.pattern && l.concurrency === p.concurrency)) {
      levels.push({ pattern: p.pattern, concurrency: p.concurrency, label: `${p.pattern} ${p.concurrency}` });
    }
  }
  levels.sort((a, b) => (a.pattern === b.pattern ? a.concurrency - b.concurrency : a.pattern === "hammer-seat" ? -1 : 1));

  const W = 980;
  const left = 78;
  const right = 24;
  const plotW = W - left - right;
  const panelH = 230;
  const defs = mechanisms.map((m) => patternDef(m, textureFor(m))).filter(Boolean).join("\n");
  const body: string[] = [];

  body.push(text(left, 28, "Throughput and p99 latency by Mechanism and load level", { size: 18, weight: "bold" }));
  body.push(
    text(left, 48, "Exhibit C. Mean across repeats per cell; one machine, containerized Postgres. Higher throughput is better, lower p99 is better.", {
      size: 11,
      fill: MUTED,
    }),
  );

  // Legend, three per row.
  const legendTop = 66;
  mechanisms.forEach((m, i) => {
    const x = left + (i % 3) * 300;
    const y = legendTop + Math.floor(i / 3) * 20;
    const tex = textureFor(m);
    body.push(
      `<rect data-series="${esc(m)}" fill="${fillFor(m, tex)}" x="${r(x)}" y="${r(y)}" width="18" height="12" stroke="#222222" stroke-width="1"/>`,
    );
    body.push(text(x + 24, y + 10, mechanismLabel(m), { size: 12 }));
  });

  const panels: { title: string; value: (p: ComparisonPoint) => number; top: number }[] = [
    { title: "Throughput (req/s)", value: (p) => p.throughputRps, top: 130 },
    { title: "p99 (ms)", value: (p) => p.p99Ms, top: 130 + panelH + 70 },
  ];

  for (const panel of panels) {
    const top = panel.top;
    const bottom = top + panelH;
    const maxValue = Math.max(0, ...points.map(panel.value));
    // Headroom for the rotated value labels above the tallest bar.
    const { max, step } = niceScale(maxValue * 1.18);
    const y = (v: number) => bottom - (v / max) * panelH;

    body.push(text(left, top - 10, panel.title, { size: 13, weight: "bold" }));
    for (const t of ticks(0, max, step)) {
      body.push(line(left, y(t), left + plotW, y(t)));
      body.push(text(left - 8, y(t) + 4, tickLabel(t), { size: 10, anchor: "end", fill: MUTED }));
    }
    body.push(line(left, top, left, bottom, "#444444"));
    body.push(line(left, bottom, left + plotW, bottom, "#444444"));
    body.push(text(16, top + panelH / 2, panel.title, { size: 11, anchor: "middle", fill: MUTED, rotate: -90 }));

    const groupW = plotW / levels.length;
    const barW = Math.min(26, (groupW * 0.84) / mechanisms.length);
    levels.forEach((level, li) => {
      const groupLeft = left + li * groupW;
      const clusterW = barW * mechanisms.length;
      const start = groupLeft + (groupW - clusterW) / 2;
      mechanisms.forEach((m, mi) => {
        const p = points.find((q) => q.mechanism === m && q.pattern === level.pattern && q.concurrency === level.concurrency);
        if (!p) return;
        const v = panel.value(p);
        const x = start + mi * barW;
        const h = bottom - y(v);
        body.push(
          `<rect data-mechanism="${esc(m)}" data-load="${esc(level.label)}" x="${r(x + 1)}" y="${r(y(v))}" width="${r(barW - 2)}" height="${r(h)}" fill="${fillFor(m)}" stroke="#222222" stroke-width="1"/>`,
        );
        body.push(text(x + barW / 2 + 3, y(v) - 4, v.toFixed(1), { size: 9, rotate: -90 }));
      });
      body.push(text(groupLeft + groupW / 2, bottom + 18, level.label, { size: 12, anchor: "middle" }));
    });
    body.push(text(left + plotW / 2, bottom + 36, "Load level (pattern, concurrency)", { size: 11, anchor: "middle", fill: MUTED }));
  }

  const height = panels[1]!.top + panelH + 60;
  return svgDoc(
    W,
    height,
    "Throughput and p99 latency by Mechanism and load level",
    `Grouped bars, one group per load level (${levels.map((l) => l.label).join(", ")}), one bar per Mechanism and the Control. Top panel is throughput in requests per second, bottom panel is p99 latency in milliseconds. Each Mechanism and the Control has its own fill pattern.`,
    defs,
    body,
  );
}

// ---------------------------------------------------------------------------
// Chart 2 — deadlocks before and after the lock-ordering fix (Exhibit D)

function renderDeadlock(data: DeadlockData): string {
  const sum = (runs: DeadlockRun[], f: (run: DeadlockRun) => number) => runs.reduce((s, x) => s + f(x), 0);
  const beforeTotal = sum(data.before, (x) => x.deadlocks);
  const afterTotal = sum(data.after, (x) => x.deadlocks);
  const beforeRequests = sum(data.before, (x) => x.requests);
  const afterRequests = sum(data.after, (x) => x.requests);
  const repeats = Math.max(data.before.length, data.after.length);

  const W = 760;
  const H = 520;
  const left = 78;
  const right = 30;
  const top = 150;
  const plotH = 260;
  const bottom = top + plotH;
  const plotW = W - left - right;

  const series = [
    { key: "before", label: `Before: unordered seat_ids, no deadlock retry, ${beforeTotal} deadlocks`, fill: "url(#pat-before)", runs: data.before },
    { key: "after", label: `After: sorted seat_ids + withDeadlockRetry, ${afterTotal} deadlocks`, fill: "#0072B2", runs: data.after },
  ];
  const defs =
    `<pattern id="pat-before" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#D55E00"/><path d="M-1 7L7 -1M-1 1L1 -1M5 7L7 5" stroke="#000000" stroke-width="1.3"/></pattern>`;

  const maxCount = Math.max(1, ...data.before.map((x) => x.deadlocks), ...data.after.map((x) => x.deadlocks));
  const { max, step } = niceScale(maxCount * 1.25, 5);
  const y = (v: number) => bottom - (v / max) * plotH;

  const body: string[] = [];
  body.push(text(left, 28, "Deadlocks before and after the lock-ordering fix", { size: 18, weight: "bold" }));
  const requestsNote = afterRequests === beforeRequests ? "" : ` (after: ${thousands(afterRequests)} requests)`;
  body.push(text(left, 48, `Exhibit D. Deadlocks / ${thousands(beforeRequests)} requests${requestsNote}, naive's multi-seat path, two-seat pairs requested in both orders.`, { size: 11, fill: MUTED }));
  body.push(text(left, 64, "A deadlock is a Postgres 40P01 abort that reached the client as an unhandled HTTP 500.", { size: 11, fill: MUTED }));

  series.forEach((s, i) => {
    const ly = 84 + i * 22;
    body.push(`<rect data-series="${s.key}" fill="${s.fill}" x="${left}" y="${ly}" width="18" height="12" stroke="#222222" stroke-width="1"/>`);
    body.push(text(left + 26, ly + 10, s.label, { size: 12 }));
  });

  for (const t of ticks(0, max, step)) {
    body.push(line(left, y(t), left + plotW, y(t)));
    body.push(text(left - 8, y(t) + 4, tickLabel(t), { size: 10, anchor: "end", fill: MUTED }));
  }
  body.push(line(left, top, left, bottom, "#444444"));
  body.push(line(left, bottom, left + plotW, bottom, "#444444"));
  body.push(text(18, top + plotH / 2, "Deadlocks per repeat (unhandled 40P01)", { size: 11, anchor: "middle", fill: MUTED, rotate: -90 }));

  const groupW = plotW / Math.max(1, repeats);
  const barW = Math.min(64, groupW * 0.32);
  for (let i = 0; i < repeats; i++) {
    const center = left + groupW * (i + 0.5);
    series.forEach((s, si) => {
      const run = s.runs[i];
      if (!run) return;
      const x = center + (si === 0 ? -barW - 3 : 3);
      const h = bottom - y(run.deadlocks);
      body.push(
        `<rect data-series="${s.key}-bar" data-repeat="${i + 1}" x="${r(x)}" y="${r(y(run.deadlocks))}" width="${r(barW)}" height="${r(h)}" fill="${s.fill}" stroke="#222222" stroke-width="1"/>`,
      );
      // A zero is drawn as a label sitting on the baseline, never as nothing.
      body.push(text(x + barW / 2, y(run.deadlocks) - 6, String(run.deadlocks), { size: 14, anchor: "middle", weight: "bold" }));
    });
    body.push(text(center, bottom + 20, `Repeat ${i + 1}`, { size: 12, anchor: "middle" }));
  }
  body.push(text(left + plotW / 2, bottom + 44, "Independent repeat", { size: 11, anchor: "middle", fill: MUTED }));
  body.push(
    text(
      left,
      H - 16,
      data.anyDoubleBooked
        ? "A Seat was double-booked in at least one of these runs."
        : "No Seat was double-booked in any of these runs (the Backstop, booking_seats.seat_id UNIQUE, ADR-0008, held).",
      { size: 11, fill: MUTED },
    ),
  );

  return svgDoc(
    W,
    H,
    "Deadlocks before and after the lock-ordering fix",
    `Grouped bars per repeat. Before the fix: ${beforeTotal} deadlocks across ${thousands(beforeRequests)} requests. After the fix: ${afterTotal} deadlocks across ${thousands(afterRequests)} requests.`,
    defs,
    body,
  );
}

// ---------------------------------------------------------------------------
// Chart 3 — cross-seat isolation degradation against the 10% threshold (Exhibit E)

function renderIsolation(points: IsolationPoint[]): string {
  const rows = sortedByMechanism(points);
  const W = 900;
  const rowH = 44;
  const top = 128;
  const left = 270;
  const plotW = 340;
  const valueX = 700;
  const verdictX = 790;
  const thresholdPct = NFR2_DEGRADATION_THRESHOLD * 100;
  const thresholdLabel = `${thresholdPct}%`;

  const pcts = rows.filter((p) => p.degradation !== null).map((p) => p.degradation! * 100);
  const lo = Math.min(0, ...pcts);
  const hi = Math.max(thresholdPct, ...pcts);
  const { step } = niceScale(hi - lo, 6);
  const axisMin = Math.floor(lo / step - 1e-9) * step;
  const axisMax = Math.ceil(hi / step - 1e-9) * step;
  const x = (pct: number) => left + ((pct - axisMin) / (axisMax - axisMin)) * plotW;
  const bottom = top + rows.length * rowH;

  const defs =
    // PASS is a plain light fill, FAIL a dense dark hatch: they differ in texture, not only in color.
    `<pattern id="pat-fail" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#D55E00"/><path d="M-1 7L7 -1M-1 1L1 -1M5 7L7 5" stroke="#000000" stroke-width="1.6"/></pattern>`;

  const body: string[] = [];
  body.push(text(40, 28, `Cross-seat isolation: degradation against the ${thresholdLabel} threshold`, { size: 18, weight: "bold" }));
  body.push(
    text(40, 48, "Exhibit E (NFR2). Background-stream p99 with a hot seat, relative to the background-only baseline; each Mechanism at the widened connection configuration.", {
      size: 11,
      fill: MUTED,
    }),
  );
  body.push(text(40, 64, `Lower is better; strictly under ${thresholdLabel} passes, so exactly ${thresholdPct.toFixed(1)}% fails.`, { size: 11, fill: MUTED }));

  body.push(`<rect fill="#56B4E9" x="40" y="80" width="18" height="12" stroke="#222222" stroke-width="1"/>`);
  body.push(text(64, 90, `PASS: under the ${thresholdLabel} threshold`, { size: 12 }));
  body.push(`<rect fill="url(#pat-fail)" x="300" y="80" width="18" height="12" stroke="#222222" stroke-width="1"/>`);
  body.push(text(324, 90, `FAIL: at or over the ${thresholdLabel} threshold`, { size: 12 }));

  body.push(text(valueX, top - 14, "Degradation", { size: 12, anchor: "end", weight: "bold" }));
  body.push(text(verdictX, top - 14, `Pass (<${thresholdLabel})?`, { size: 12, weight: "bold" }));

  for (const t of ticks(axisMin, axisMax, step)) {
    body.push(line(x(t), top - 4, x(t), bottom, GRID));
    body.push(text(x(t), bottom + 16, `${tickLabel(t)}%`, { size: 10, anchor: "middle", fill: MUTED }));
  }
  body.push(line(x(0), top - 4, x(0), bottom, "#444444"));
  body.push(line(x(thresholdPct), top - 4, x(thresholdPct), bottom, INK, 2, "6 4"));
  body.push(text(x(thresholdPct), top - 20, `${thresholdLabel} threshold`, { size: 11, anchor: "middle", weight: "bold" }));
  body.push(text(left + plotW / 2, bottom + 38, "Degradation of background p99 vs. background-only baseline (%)", { size: 11, anchor: "middle", fill: MUTED }));

  rows.forEach((p, i) => {
    const yTop = top + i * rowH;
    const yMid = yTop + rowH / 2;
    body.push(text(left - 14, yMid + 4, mechanismLabel(p.mechanism), { size: 12, anchor: "end" }));
    const pass = passesNfr2(p.degradation);
    const verdict = pass === null ? "missing data" : pass ? "PASS" : "FAIL";
    if (p.degradation === null) {
      body.push(text(valueX, yMid + 4, fmtPctSigned(null), { size: 12, anchor: "end", attrs: `data-mechanism="${esc(p.mechanism)}" data-verdict="missing data"` }));
      body.push(text(verdictX, yMid + 4, "missing data", { size: 12 }));
      return;
    }
    const pct = p.degradation * 100;
    const x0 = x(0);
    const x1 = x(pct);
    body.push(
      `<rect data-mechanism="${esc(p.mechanism)}" data-verdict="${verdict}" x="${r(Math.min(x0, x1))}" y="${r(yTop + 8)}" width="${r(Math.max(Math.abs(x1 - x0), 1))}" height="${rowH - 16}" fill="${pass ? "#56B4E9" : "url(#pat-fail)"}" stroke="#222222" stroke-width="1"/>`,
    );
    body.push(text(valueX, yMid + 4, fmtPctSigned(p.degradation), { size: 13, anchor: "end", weight: "bold" }));
    body.push(text(verdictX, yMid + 4, `${pass ? "✓" : "✗"} ${verdict}`, { size: 13, weight: "bold" }));
  });

  return svgDoc(
    W,
    bottom + 60,
    `Cross-seat isolation degradation against the ${thresholdLabel} threshold`,
    `Horizontal bars, one per Mechanism and the Control, showing how much a hot seat degrades the p99 latency of bookings for unrelated seats. A dashed line marks the ${thresholdLabel} threshold; each bar is labelled PASS or FAIL.`,
    defs,
    body,
  );
}

// ---------------------------------------------------------------------------
// Chart 4 — Oracle results across the chaos matrix (Exhibit H)

// Exhibit H's own Fault names, in its own order.
const FAULT_ORDER = ["latency-below", "latency-above", "partition-stall", "partition-reset", "app-sigkill"];

function faultsOf(cells: ChaosCell[]): string[] {
  const present = [...new Set(cells.map((c) => c.fault))];
  const known = FAULT_ORDER.filter((f) => present.includes(f));
  const other = present.filter((f) => !FAULT_ORDER.includes(f)).sort();
  return [...known, ...other];
}

function renderChaos(cells: ChaosCell[]): string {
  const labelW = 260;
  const colW = 118;
  const rowH = 34;
  const left = 40;
  const mechanisms = mechanismsOf(cells);
  // One column per Fault in the widest panel, plus the rollup column.
  const widestPanel = Math.max(1, ...(["unmodified", "scaffolded"] as const).map((v) => faultsOf(cells.filter((c) => c.variant === v)).length));
  const W = Math.max(960, left + labelW + (widestPanel + 1) * colW + left);

  const panels = [
    {
      variant: "unmodified" as const,
      title: "Unmodified code (Exhibit H, A1 and A2)",
      note: "The application as shipped (R1/R2: it exits on the first torn connection, then the harness restarts it).",
    },
    {
      variant: "scaffolded" as const,
      title: "With the --survive-uncaught scaffold (Exhibit H, B1 and B2)",
      note: "Reported separately and never merged with the unmodified runs: the scaffold keeps the process alive past torn connections.",
    },
  ].filter((p) => cells.some((c) => c.variant === p.variant));

  const defs =
    `<pattern id="pat-violation" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#D55E00"/><path d="M-1 7L7 -1M-1 1L1 -1M5 7L7 5" stroke="#000000" stroke-width="1.6"/></pattern>`;

  const body: string[] = [];
  body.push(text(left, 28, "Oracle results across the chaos matrix", { size: 18, weight: "bold" }));
  body.push(
    text(left, 48, "Exhibit H, C2 Fault matrix. Each cell: Oracle-clean runs/total, both loads (hammer-seat, deadlock-pairs) together. A cell with a Correctness violation is hatched and marked with a cross.", {
      size: 11,
      fill: MUTED,
    }),
  );
  body.push(`<rect fill="#E8F1F8" x="${left}" y="62" width="18" height="12" stroke="#222222" stroke-width="1"/>`);
  body.push(text(left + 24, 72, "Every run Oracle-clean", { size: 12 }));
  body.push(`<rect fill="url(#pat-violation)" x="${left + 220}" y="62" width="18" height="12" stroke="#222222" stroke-width="1"/>`);
  body.push(text(left + 244, 72, "At least one Correctness violation", { size: 12 }));

  let cursor = 100;
  for (const panel of panels) {
    const inPanel = cells.filter((c) => c.variant === panel.variant);
    const faults = faultsOf(inPanel);
    body.push(text(left, cursor, panel.title, { size: 14, weight: "bold" }));
    const panelRuns = inPanel.reduce((n, c) => n + c.runs, 0);
    const panelCrashed = inPanel.reduce((n, c) => n + c.crashed, 0);
    body.push(text(left, cursor + 16, `${panel.note} The application process exited in ${panelCrashed} of ${panelRuns} runs.`, { size: 11, fill: MUTED }));
    const headY = cursor + 44;
    faults.forEach((f, i) => body.push(text(left + labelW + i * colW + colW / 2, headY, f, { size: 11, anchor: "middle", weight: "bold" })));
    body.push(text(left + labelW + faults.length * colW + colW / 2, headY, "All Faults", { size: 11, anchor: "middle", weight: "bold" }));
    body.push(text(left + 4, headY, "Mechanism", { size: 11, weight: "bold" }));
    body.push(text(left + labelW + (faults.length + 1) * colW, headY + 16, "Oracle-clean runs/total", { size: 10, anchor: "end", fill: MUTED }));

    mechanisms.forEach((m, mi) => {
      const yTop = headY + 24 + mi * rowH;
      body.push(text(left + 4, yTop + rowH / 2 + 4, mechanismLabel(m), { size: 12 }));
      let clean = 0;
      let runs = 0;
      const drawCell = (col: number, c: number, n: number, bold: boolean) => {
        const ok = n > 0 && c === n;
        const cx = left + labelW + col * colW;
        const label = n === 0 ? "—" : `${c}/${n}`;
        body.push(
          `<rect data-mechanism="${esc(m)}" data-clean="${n === 0 ? "none" : ok ? "yes" : "no"}" x="${r(cx + 3)}" y="${r(yTop + 3)}" width="${colW - 6}" height="${rowH - 6}" fill="${ok || n === 0 ? "#E8F1F8" : "url(#pat-violation)"}" stroke="#222222" stroke-width="1"/>`,
        );
        body.push(text(cx + colW / 2, yTop + rowH / 2 + 5, n === 0 ? label : `${label} ${ok ? "✓" : "✗"}`, { size: 13, anchor: "middle", weight: bold || !ok ? "bold" : undefined }));
      };
      faults.forEach((f, fi) => {
        const cell = inPanel.filter((c) => c.mechanism === m && c.fault === f);
        const c = cell.reduce((s, x) => s + x.clean, 0);
        const n = cell.reduce((s, x) => s + x.runs, 0);
        clean += c;
        runs += n;
        drawCell(fi, c, n, false);
      });
      drawCell(faults.length, clean, runs, true);
    });
    cursor = headY + 24 + mechanisms.length * rowH + 44;
  }

  body.push(text(left, cursor - 14, "Oracles 1-4 read stored database state, never HTTP responses. A clean matrix is evidence about the Oracles' verdict, not about the application surviving the Fault.", { size: 11, fill: MUTED }));

  return svgDoc(
    W,
    cursor + 6,
    "Oracle results across the chaos matrix",
    "A matrix of Mechanisms and the Control by injected Fault giving the number of runs in which every Oracle passed over the number of runs, for unmodified code and, separately, with the survive-uncaught scaffold.",
    defs,
    body,
  );
}
