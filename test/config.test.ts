// Regression test for a bug a code-review pass caught before this ticket
// merged: HOLD_TTL_SECONDS previously accepted 0/negative values with no
// validation, silently producing holds whose held_until was already in the
// past — a seat stuck 'held' forever with no path back to 'available' (no
// reaper exists yet). config.ts's intEnv now takes an optional `min` bound;
// holdTtlSeconds passes { min: 1 } so a bad value fails fast at process
// startup instead of surfacing as a dead-on-arrival hold at request time.
process.env.BOOKING_STRATEGY = "naive";

const { afterEach, describe, expect, it, vi } = await import("vitest");

const DB_TIMEOUT_ENV = [
  "DB_STATEMENT_TIMEOUT_MS",
  "DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  "DB_QUERY_TIMEOUT_MS",
  "DB_CONNECT_TIMEOUT_MS",
] as const;

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
    delete process.env.RETRY_BUDGET_MS;
    for (const name of DB_TIMEOUT_ENV) delete process.env[name];
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

  // Issue #56 (R4, ADR-0026). Same { min: 1 } rule as HOLD_TTL_SECONDS: pg treats 0 as "no
  // timeout", so a zero/negative override would silently turn the bound back off.
  it.each(DB_TIMEOUT_ENV)("throws at startup when %s is zero or negative", async (name) => {
    process.env[name] = "0";
    await expect(import("../src/config.js")).rejects.toThrow(new RegExp(name));
  });

  // Issue #59 (R6, ADR-0028). Same { min: 1 } rule: a zero budget would make every request give
  // up after its first attempt, which is a different (and silent) behaviour from "no budget".
  it("throws at startup when RETRY_BUDGET_MS is zero or negative", async () => {
    process.env.RETRY_BUDGET_MS = "0";
    await expect(import("../src/config.js")).rejects.toThrow(/RETRY_BUDGET_MS/);
  });

  it("has a retry budget below a typical 5 s client timeout by default", async () => {
    const { config } = await import("../src/config.js");
    expect(config.retryBudgetMs).toBeGreaterThan(0);
    expect(config.retryBudgetMs).toBeLessThan(5000);
  });

  it("has bounded defaults, each well below a typical 5 s client timeout", async () => {
    const { config } = await import("../src/config.js");

    expect(config.dbStatementTimeoutMs).toBeGreaterThan(0);
    expect(config.dbIdleInTransactionTimeoutMs).toBeGreaterThan(0);
    // The sum is the longest a stalled transaction can stay open server-side:
    // one statement cut off by statement_timeout, then idle until it is ended.
    expect(config.dbStatementTimeoutMs + config.dbIdleInTransactionTimeoutMs).toBeLessThan(5000);
    expect(config.dbQueryTimeoutMs).toBeLessThan(5000);
    expect(config.dbConnectTimeoutMs).toBeLessThan(5000);
  });

  // If the client gave up first, a healthy-but-slow statement would be reported as an
  // infrastructure timeout and its connection destroyed, when the server was about to answer
  // with an ordinary, connection-preserving statement_timeout error.
  it("throws at startup when the client query timeout does not exceed the server statement timeout", async () => {
    process.env.DB_STATEMENT_TIMEOUT_MS = "2000";
    process.env.DB_QUERY_TIMEOUT_MS = "2000";
    await expect(import("../src/config.js")).rejects.toThrow(/DB_QUERY_TIMEOUT_MS/);
  });
});
