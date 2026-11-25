// Issue #55 (finding R3), half 1: a failing ROLLBACK must never mask the error
// that made the transaction fail, and must never change a designed outcome.
//
// No database: each helper only ever calls `client.query`, so a scripted fake
// client lets a test fail any chosen statement — including the ROLLBACK a dead
// connection would throw on — deterministically, which a real Postgres cannot
// do on demand.
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeadlockRetriesExhaustedError,
  SerializationRetriesExhaustedError,
  withDeadlockRetry,
  withSerializableTransaction,
  withTransaction,
} from "../../src/db/pool.js";

const rollbackError = new Error("Connection terminated unexpectedly (ROLLBACK)");

interface FakeClient {
  client: PoolClient;
  statements: string[];
}

// `failures` maps a statement prefix to the error its query rejects with.
function fakeClient(failures: Record<string, Error>): FakeClient {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      for (const [prefix, err] of Object.entries(failures)) {
        if (sql.startsWith(prefix)) throw err;
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, statements };
}

let logged: string[];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

const statementError = Object.assign(new Error("syntax error at or near \"FROM\""), { code: "42601" });

// Each helper, driven the same way: `begin` is how it opens a transaction, and
// `exhausted` builds a call that always fails with its own retriable code so the
// retry budget (zero) is exhausted on the first failure.
const helpers = [
  {
    name: "withTransaction",
    run: (client: PoolClient, fn: () => Promise<unknown>, shouldCommit?: (r: unknown) => boolean) =>
      withTransaction<unknown>(client, fn, shouldCommit),
    begin: "BEGIN",
  },
  {
    name: "withSerializableTransaction",
    run: (client: PoolClient, fn: () => Promise<unknown>, shouldCommit?: (r: unknown) => boolean) =>
      withSerializableTransaction<unknown>(client, fn, shouldCommit),
    begin: "BEGIN ISOLATION LEVEL SERIALIZABLE",
  },
  {
    name: "withDeadlockRetry",
    run: (client: PoolClient, fn: () => Promise<unknown>, shouldCommit?: (r: unknown) => boolean) =>
      withDeadlockRetry<unknown>(client, fn, shouldCommit),
    begin: "BEGIN",
  },
] as const;

describe.each(helpers)("$name: a failing ROLLBACK", (helper) => {
  it("surfaces the statement's own error, not the ROLLBACK's, and logs the ROLLBACK failure as secondary", async () => {
    const { client } = fakeClient({ ROLLBACK: rollbackError });

    const outcome = await helper
      .run(client, async () => {
        throw statementError;
      })
      .then(
        () => ({ threw: false as const }),
        (err: unknown) => ({ threw: true as const, err }),
      );

    expect(outcome.threw).toBe(true);
    // Identity, not just message: callers match on `code`/`constraint` and
    // `instanceof`, so the original object must come through untouched.
    expect((outcome as { err: unknown }).err).toBe(statementError);
    // The secondary failure is still visible to an operator, next to the
    // original's message, rather than lost.
    expect(logged.join("\n")).toContain(rollbackError.message);
    expect(logged.join("\n")).toContain(statementError.message);
  });

  it("still returns a designed no-commit result (a conflict / not-found) instead of throwing", async () => {
    const { client, statements } = fakeClient({ ROLLBACK: rollbackError });

    const result = await helper.run(
      client,
      async () => ({ kind: "conflict" }),
      () => false,
    );

    expect(result).toEqual({ kind: "conflict" });
    // It did attempt the rollback — the failure was tolerated, not skipped.
    expect(statements).toContain("ROLLBACK");
  });

  it("does not swallow a COMMIT failure: its outcome is unknown, so it must reach the caller", async () => {
    const commitError = Object.assign(new Error("Connection terminated unexpectedly (COMMIT)"), {});
    const { client } = fakeClient({ COMMIT: commitError, ROLLBACK: rollbackError });

    await expect(helper.run(client, async () => ({ kind: "created" }))).rejects.toBe(commitError);
  });

  it("with a healthy connection, still rolls back and rethrows the statement error (unchanged behavior)", async () => {
    const { client, statements } = fakeClient({});

    await expect(
      helper.run(client, async () => {
        throw statementError;
      }),
    ).rejects.toBe(statementError);
    expect(statements).toEqual([helper.begin, "ROLLBACK"]);
    expect(logged).toEqual([]);
  });
});

describe("withSerializableTransaction: a failing ROLLBACK and a retriable error", () => {
  it("still reports retry exhaustion (503's cause), not the ROLLBACK error, when the budget is spent", async () => {
    const { client } = fakeClient({ ROLLBACK: rollbackError });

    await expect(
      withSerializableTransaction(
        client,
        async () => {
          throw { code: "40001" };
        },
        () => true,
        { maxRetries: 0 },
      ),
    ).rejects.toBeInstanceOf(SerializationRetriesExhaustedError);
  });

  it("with budget left, the retry's own BEGIN on the dead connection fails — an infrastructure error, not a swallowed one", async () => {
    const beginError = new Error("Client has encountered a connection error and is not queryable");
    let begins = 0;
    const client = {
      query: async (sql: string) => {
        if (sql.startsWith("ROLLBACK")) throw rollbackError;
        if (sql.startsWith("BEGIN") && ++begins > 1) throw beginError;
        return { rows: [] };
      },
    } as unknown as PoolClient;

    await expect(
      withSerializableTransaction(
        client,
        async () => {
          throw { code: "40001" };
        },
        () => true,
        { maxRetries: 3 },
      ),
    ).rejects.toBe(beginError);
  });
});

describe("withDeadlockRetry: a failing ROLLBACK and a deadlock abort", () => {
  it("still reports retry exhaustion when the budget is spent", async () => {
    const { client } = fakeClient({ ROLLBACK: rollbackError });

    await expect(
      withDeadlockRetry(
        client,
        async () => {
          throw { code: "40P01" };
        },
        () => true,
        { maxRetries: 0 },
      ),
    ).rejects.toBeInstanceOf(DeadlockRetriesExhaustedError);
  });
});
