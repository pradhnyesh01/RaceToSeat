// Regression test for a bug a code-review pass caught before this ticket
// merged: HOLD_TTL_SECONDS previously accepted 0/negative values with no
// validation, silently producing holds whose held_until was already in the
// past — a seat stuck 'held' forever with no path back to 'available' (no
// reaper exists yet). config.ts's intEnv now takes an optional `min` bound;
// holdTtlSeconds passes { min: 1 } so a bad value fails fast at process
// startup instead of surfacing as a dead-on-arrival hold at request time.
process.env.BOOKING_STRATEGY = "naive";

const { afterEach, describe, expect, it } = await import("vitest");

describe("config", () => {
  // vitest.config.ts's fileParallelism: false runs every file sequentially
  // in one process with nothing resetting process.env between files (see
  // cancellation.test.ts) — an un-cleared HOLD_TTL_SECONDS="0" here would
  // make every later file's fresh config.js import throw too.
  afterEach(() => {
    delete process.env.HOLD_TTL_SECONDS;
  });

  it("throws at startup when HOLD_TTL_SECONDS is zero or negative", async () => {
    process.env.HOLD_TTL_SECONDS = "0";
    await expect(import("../src/config.js")).rejects.toThrow(/HOLD_TTL_SECONDS/);
  });
});
