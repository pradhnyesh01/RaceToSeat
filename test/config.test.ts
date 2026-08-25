// Regression test for a bug a code-review pass caught before this ticket
// merged: HOLD_TTL_SECONDS previously accepted 0/negative values with no
// validation, silently producing holds whose held_until was already in the
// past — a seat stuck 'held' forever with no path back to 'available' (no
// reaper exists yet). config.ts's intEnv now takes an optional `min` bound;
// holdTtlSeconds passes { min: 1 } so a bad value fails fast at process
// startup instead of surfacing as a dead-on-arrival hold at request time.
process.env.BOOKING_STRATEGY = "naive";

const { afterEach, describe, expect, it, vi } = await import("vitest");

describe("config", () => {
  // vitest.config.ts's fileParallelism: false runs every file sequentially
  // in one process with nothing resetting process.env between files (see
  // cancellation.test.ts) — an un-cleared HOLD_TTL_SECONDS="0" here would
  // make every later file's fresh config.js import throw too. vi.resetModules()
  // is needed within *this* file too: Node's ESM cache remembers a module's
  // outcome (including a rejection) by specifier, so a second `import
  // ("../src/config.js")` in a later test would otherwise silently replay
  // the first test's cached rejection instead of re-evaluating against this
  // test's own env var.
  afterEach(() => {
    delete process.env.HOLD_TTL_SECONDS;
    delete process.env.REAPER_INTERVAL_MS;
    vi.resetModules();
  });

  it("throws at startup when HOLD_TTL_SECONDS is zero or negative", async () => {
    process.env.HOLD_TTL_SECONDS = "0";
    await expect(import("../src/config.js")).rejects.toThrow(/HOLD_TTL_SECONDS/);
  });

  // Same rationale and { min: 1 } pattern as HOLD_TTL_SECONDS above — a
  // zero/negative interval would make setInterval fire as a tight loop
  // (found missing coverage in code review, since this config path is
  // otherwise only exercised by server.ts, which isn't unit tested).
  it("throws at startup when REAPER_INTERVAL_MS is zero or negative", async () => {
    process.env.REAPER_INTERVAL_MS = "-1";
    await expect(import("../src/config.js")).rejects.toThrow(/REAPER_INTERVAL_MS/);
  });
});
