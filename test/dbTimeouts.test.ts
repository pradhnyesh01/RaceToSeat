// Issue #56 (finding R4, ADR-0026): nothing in the stack used to give up. These tests run
// against a real Postgres and pin the part of the fix a unit test can reach: the server-side
// bounds the app pool installs on every connection, that each one actually fires, and — the
// collision the ticket calls out — that a timeout is never reported as a seat conflict.
//
// The stalled-connection half (a partition: bytes stop flowing, nothing errors) lives in
// stalledConnection.test.ts; the end-to-end partition evidence is Exhibit H section G.
process.env.BOOKING_STRATEGY = "pessimistic";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const { pool, withDeadlockRetry, withSerializableTransaction, SerializationRetriesExhaustedError, DeadlockRetriesExhaustedError } = await import("../src/db/pool.js");
const { isInfrastructureFailure, isLockNotAvailable, isLockTimeout, isTimeoutFailure } = await import("../src/db/pgErrors.js");
const { resetDb, seedEventWithSeats } = await import("./testDb.js");
const { default: pg } = await import("pg");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

// Holds a row lock on a connection that is NOT subject to the app's bounds (testDb's
// withHeldRowLock borrows one from the app pool, which would itself be ended by
// idle_in_transaction_session_timeout while the statement under test waits on it).
async function withUnboundedRowLock<T>(seatId: string, fn: () => Promise<T>): Promise<T> {
  const holder = new pg.Client({ connectionString: config.databaseUrl });
  await holder.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM seats WHERE id = $1 FOR UPDATE", [seatId]);
    return await fn();
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await holder.end();
  }
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("expected the statement to fail");
}

describe("the app pool's server-side bounds (R4)", () => {
  it("installs statement_timeout and idle_in_transaction_session_timeout on every connection", async () => {
    const res = await pool.query<{ statement_timeout: string; idle: string }>(
      "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('idle_in_transaction_session_timeout') AS idle",
    );

    expect(res.rows[0]).toEqual({
      statement_timeout: `${config.dbStatementTimeoutMs}ms`,
      idle: `${config.dbIdleInTransactionTimeoutMs}ms`,
    });
  });

  it("does NOT configure lock_timeout: it raises 55P03, the code NOWAIT conflicts already use", async () => {
    const res = await pool.query<{ lock_timeout: string }>("SELECT current_setting('lock_timeout') AS lock_timeout");

    expect(res.rows[0]!.lock_timeout).toBe("0");
  });

  it("cancels a statement that runs past statement_timeout, and classifies it as a timeout", async () => {
    const err = await failureOf(() => pool.query("SELECT pg_sleep($1)", [(config.dbStatementTimeoutMs * 3) / 1000]));

    expect(err).toMatchObject({ code: "57014" });
    expect(isTimeoutFailure(err)).toBe(true);
  });

  it("ends a transaction left idle past idle_in_transaction_session_timeout, releasing its row locks", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;
    const client = await pool.connect();
    client.on("error", () => {}); // the server terminating the session is expected here
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM seats WHERE id = $1 FOR UPDATE", [seatId]);
      await new Promise((resolve) => setTimeout(resolve, config.dbIdleInTransactionTimeoutMs + 700));

      // The lock is gone: a second connection can take it without NOWAIT failing.
      const probe = await pool.connect();
      try {
        await probe.query("BEGIN");
        await probe.query("SELECT 1 FROM seats WHERE id = $1 FOR UPDATE NOWAIT", [seatId]);
        await probe.query("ROLLBACK");
      } finally {
        probe.release();
      }

      // ...and the idle session itself was terminated. The server's FATAL arrives as a
      // connection error, so the next statement fails as a dead connection (502 at the API).
      const err = await failureOf(() => client.query("SELECT 1"));
      expect(isTimeoutFailure(err) || isInfrastructureFailure(err)).toBe(true);
    } finally {
      client.release(true);
    }
  }, 15_000);
});

describe("a timeout is not a seat conflict (the 55P03 collision, R4)", () => {
  beforeEach(resetDb);

  it("a lock wait cut off by statement_timeout is 57014, never the 55P03 that isLockNotAvailable translates to 409", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;

    const err = await withUnboundedRowLock(seatId, () =>
      failureOf(() => pool.query("UPDATE seats SET version = version + 1 WHERE id = $1", [seatId])),
    );

    expect(err).toMatchObject({ code: "57014" });
    expect(isLockNotAvailable(err)).toBe(false);
    expect(isTimeoutFailure(err)).toBe(true);
  });

  it("a genuine lock_timeout (if an operator sets one) is 55P03 too, but is told apart from a NOWAIT conflict", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;

    const { lockTimeoutErr, nowaitErr } = await withUnboundedRowLock(seatId, async () => {
      const client = await pool.connect();
      try {
        await client.query("SET lock_timeout = '150ms'");
        const lockTimeoutErr = await failureOf(() => client.query("UPDATE seats SET version = version + 1 WHERE id = $1", [seatId]));
        const nowaitErr = await failureOf(() => client.query("SELECT 1 FROM seats WHERE id = $1 FOR UPDATE NOWAIT", [seatId]));
        return { lockTimeoutErr, nowaitErr };
      } finally {
        client.release();
      }
    });

    // Same SQLSTATE: the code alone cannot tell them apart.
    expect(lockTimeoutErr).toMatchObject({ code: "55P03" });
    expect(nowaitErr).toMatchObject({ code: "55P03" });
    // ...so the message does.
    expect(isLockTimeout(lockTimeoutErr)).toBe(true);
    expect(isLockNotAvailable(lockTimeoutErr)).toBe(false);
    expect(isTimeoutFailure(lockTimeoutErr)).toBe(true);
    expect(isLockNotAvailable(nowaitErr)).toBe(true);
    expect(isLockTimeout(nowaitErr)).toBe(false);
    expect(isTimeoutFailure(nowaitErr)).toBe(false);
  });

  it("a NOWAIT conflict is still a 409 booking conflict (the bound did not change the designed outcome)", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;
    const app = createApp();

    const res = await withUnboundedRowLock(seatId, () =>
      app.inject({ method: "POST", url: "/bookings", payload: { seat_ids: [seatId], user_id: "user-1", idempotency_key: randomUUID() } }),
    );

    expect(res.statusCode).toBe(409);
  });
});

// (b) NFR3 and the retry loops. The bounds are per statement (and per idle gap), so a retry
// loop whose every attempt is fast enough keeps going however long the loop runs in total:
// the clock restarts with each statement. And a bound that does fire is not a retriable
// failure — it must reach the caller as a timeout, not be spent as a retry or be disguised
// as retry_exhausted (503).
describe("the retry loops under the bounds (R4, NFR3)", () => {
  const abort = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });
  const SLOW_BUT_BOUNDED_MS = 600; // under the bounds on its own; three of them are not

  it("withSerializableTransaction keeps retrying past the statement timeout in total, because the bound is per statement", async () => {
    const client = await pool.connect();
    const started = Date.now();
    try {
      const attempts: number[] = [];
      const result = await withSerializableTransaction(client, async (c, attempt) => {
        attempts.push(attempt);
        await c.query("SELECT pg_sleep($1)", [SLOW_BUT_BOUNDED_MS / 1000]);
        if (attempt < 3) throw abort("40001");
        return "done";
      });

      expect(result).toBe("done");
      expect(attempts).toEqual([0, 1, 2, 3]);
      expect(Date.now() - started).toBeGreaterThan(config.dbStatementTimeoutMs);
    } finally {
      client.release();
    }
  }, 15_000);

  it("withDeadlockRetry keeps retrying past the statement timeout in total, because the bound is per statement", async () => {
    const client = await pool.connect();
    const started = Date.now();
    try {
      const result = await withDeadlockRetry(client, async (c, attempt) => {
        await c.query("SELECT pg_sleep($1)", [SLOW_BUT_BOUNDED_MS / 1000]);
        if (attempt < 3) throw abort("40P01");
        return "done";
      });

      expect(result).toBe("done");
      expect(Date.now() - started).toBeGreaterThan(config.dbStatementTimeoutMs);
    } finally {
      client.release();
    }
  }, 15_000);

  it("a statement timeout inside withSerializableTransaction is not retried and not retry_exhausted: it surfaces as the timeout", async () => {
    const client = await pool.connect();
    try {
      let attempts = 0;
      const err = await failureOf(() =>
        withSerializableTransaction(client, async (c) => {
          attempts++;
          await c.query("SELECT pg_sleep($1)", [(config.dbStatementTimeoutMs * 3) / 1000]);
        }),
      );

      expect(attempts).toBe(1);
      expect(err).not.toBeInstanceOf(SerializationRetriesExhaustedError);
      expect(isTimeoutFailure(err)).toBe(true);
    } finally {
      client.release();
    }
  }, 15_000);

  it("a statement timeout inside withDeadlockRetry is not retried and not retry_exhausted: it surfaces as the timeout", async () => {
    const client = await pool.connect();
    try {
      let attempts = 0;
      const err = await failureOf(() =>
        withDeadlockRetry(client, async (c) => {
          attempts++;
          await c.query("SELECT pg_sleep($1)", [(config.dbStatementTimeoutMs * 3) / 1000]);
        }),
      );

      expect(attempts).toBe(1);
      expect(err).not.toBeInstanceOf(DeadlockRetriesExhaustedError);
      expect(isTimeoutFailure(err)).toBe(true);
    } finally {
      client.release();
    }
  }, 15_000);
});
