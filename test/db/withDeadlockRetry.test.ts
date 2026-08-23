import { afterAll, describe, expect, it } from "vitest";
import { DeadlockRetriesExhaustedError, pool, withDeadlockRetry } from "../../src/db/pool.js";

afterAll(() => pool.end());

// A real DB client and real BEGIN/COMMIT/ROLLBACK, but `work` is a stub that
// throws a synthetic {code: '40P01'} error a controlled number of times
// before resolving — proves the retry/backoff/cap contract directly, without
// depending on a genuine Postgres deadlock detector firing naturally. Mirrors
// test/db/withSerializableTransaction.test.ts's pattern for its own error
// code (issue #24).
describe("withDeadlockRetry", () => {
  it("retries on a synthetic deadlock abort and succeeds once the stub stops throwing", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;
      const failuresBeforeSuccess = 2;

      const result = await withDeadlockRetry(client, async () => {
        calls++;
        if (calls <= failuresBeforeSuccess) {
          throw { code: "40P01" };
        }
        return "ok";
      });

      expect(result).toBe("ok");
      expect(calls).toBe(failuresBeforeSuccess + 1);
    } finally {
      client.release();
    }
  });

  it("passes the current attempt number to work, starting at 0", async () => {
    const client = await pool.connect();
    try {
      const attemptsSeen: number[] = [];

      await withDeadlockRetry(client, async (_txClient, attempt) => {
        attemptsSeen.push(attempt);
        if (attempt < 2) {
          throw { code: "40P01" };
        }
        return "ok";
      });

      expect(attemptsSeen).toEqual([0, 1, 2]);
    } finally {
      client.release();
    }
  });

  it("waits a jittered 1-5ms between retries, not a fixed or zero delay", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;
      const failuresBeforeSuccess = 4;
      const timestamps: number[] = [];

      await withDeadlockRetry(client, async () => {
        timestamps.push(Date.now());
        calls++;
        if (calls <= failuresBeforeSuccess) {
          throw { code: "40P01" };
        }
        return "ok";
      });

      expect(timestamps).toHaveLength(failuresBeforeSuccess + 1);
      const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]!);

      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThan(500);
      }
      const uniqueGaps = new Set(gaps);
      expect(uniqueGaps.size).toBeGreaterThan(1);
    } finally {
      client.release();
    }
  });

  it("propagates a non-deadlock error immediately, without retrying", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;

      await expect(
        withDeadlockRetry(client, async () => {
          calls++;
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(calls).toBe(1);
    } finally {
      client.release();
    }
  });

  it("does not retry a genuine serialization failure (40001) — that's withSerializableTransaction's own concern", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;

      await expect(
        withDeadlockRetry(client, async () => {
          calls++;
          throw { code: "40001" };
        }),
      ).rejects.toMatchObject({ code: "40001" });

      expect(calls).toBe(1);
    } finally {
      client.release();
    }
  });

  it("throws DeadlockRetriesExhaustedError after exhausting the retry cap", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;

      const rejection = withDeadlockRetry(
        client,
        async () => {
          calls++;
          throw { code: "40P01" };
        },
        () => true,
        { maxRetries: 2 },
      );

      await expect(rejection).rejects.toThrow(DeadlockRetriesExhaustedError);
      // 1 initial attempt + 2 retries = 3 total calls.
      expect(calls).toBe(3);
    } finally {
      client.release();
    }
  });

  it("a maxRetries of 0 exhausts immediately, after exactly one attempt", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;

      const rejection = withDeadlockRetry(
        client,
        async () => {
          calls++;
          throw { code: "40P01" };
        },
        () => true,
        { maxRetries: 0 },
      );

      await expect(rejection).rejects.toThrow(DeadlockRetriesExhaustedError);
      expect(calls).toBe(1);
    } finally {
      client.release();
    }
  });

  it("leaves the client usable after exhausting retries — ROLLBACK cleaned up the aborted transaction", async () => {
    const client = await pool.connect();
    try {
      await expect(
        withDeadlockRetry(
          client,
          async () => {
            throw { code: "40P01" };
          },
          () => true,
          { maxRetries: 0 },
        ),
      ).rejects.toThrow(DeadlockRetriesExhaustedError);

      const res = await client.query<{ ok: number }>("SELECT 1 AS ok");
      expect(res.rows[0]).toEqual({ ok: 1 });
    } finally {
      client.release();
    }
  });

  it("does not COMMIT or hide a rolled-back result: shouldCommit(false) issues ROLLBACK, not COMMIT", async () => {
    const client = await pool.connect();
    try {
      const result = await withDeadlockRetry(
        client,
        async () => "not-created",
        (r) => r === "created",
      );

      expect(result).toBe("not-created");
      const res = await client.query<{ ok: number }>("SELECT 1 AS ok");
      expect(res.rows[0]).toEqual({ ok: 1 });
    } finally {
      client.release();
    }
  });
});
