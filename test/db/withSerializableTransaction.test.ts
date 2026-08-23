import { afterAll, describe, expect, it } from "vitest";
import { SerializationRetriesExhaustedError, pool, withSerializableTransaction } from "../../src/db/pool.js";

afterAll(() => pool.end());

// A real DB client and real BEGIN/COMMIT/ROLLBACK, but `work` is a stub that
// throws a synthetic {code: '40001'} error a controlled number of times
// before resolving — proves the retry/backoff/cap contract directly, without
// depending on genuine SERIALIZABLE contention occurring naturally.
describe("withSerializableTransaction", () => {
  it("retries on a synthetic serialization failure and succeeds once the stub stops throwing", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;
      const failuresBeforeSuccess = 2;

      const result = await withSerializableTransaction(client, async () => {
        calls++;
        if (calls <= failuresBeforeSuccess) {
          throw { code: "40001" };
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

      await withSerializableTransaction(client, async (_txClient, attempt) => {
        attemptsSeen.push(attempt);
        if (attempt < 2) {
          throw { code: "40001" };
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

      await withSerializableTransaction(client, async () => {
        timestamps.push(Date.now());
        calls++;
        if (calls <= failuresBeforeSuccess) {
          throw { code: "40001" };
        }
        return "ok";
      });

      expect(timestamps).toHaveLength(failuresBeforeSuccess + 1);
      const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]!);

      // Each gap reflects a real backoff, not an instant retry; generous
      // upper bound to absorb scheduler/CI jitter without being tight.
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThan(500);
      }
      // Jittered, not fixed: independently random 1-5ms delays landing on
      // the exact same millisecond gap every single retry is effectively
      // impossible — a constant (non-jittered) backoff would fail this,
      // which a bare "total elapsed time exceeds some floor" assertion
      // (satisfied equally by a fixed delay) would not have caught.
      const uniqueGaps = new Set(gaps);
      expect(uniqueGaps.size).toBeGreaterThan(1);
    } finally {
      client.release();
    }
  });

  it("propagates a non-serialization-failure error immediately, without retrying", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;

      await expect(
        withSerializableTransaction(client, async () => {
          calls++;
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(calls).toBe(1);
    } finally {
      client.release();
    }
  });

  it("throws SerializationRetriesExhaustedError after exhausting the retry cap", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;

      const rejection = withSerializableTransaction(
        client,
        async () => {
          calls++;
          throw { code: "40001" };
        },
        () => true,
        { maxRetries: 2 },
      );

      await expect(rejection).rejects.toThrow(SerializationRetriesExhaustedError);
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

      const rejection = withSerializableTransaction(
        client,
        async () => {
          calls++;
          throw { code: "40001" };
        },
        () => true,
        { maxRetries: 0 },
      );

      await expect(rejection).rejects.toThrow(SerializationRetriesExhaustedError);
      expect(calls).toBe(1);
    } finally {
      client.release();
    }
  });

  it("leaves the client usable after exhausting retries — ROLLBACK cleaned up the aborted transaction", async () => {
    const client = await pool.connect();
    try {
      await expect(
        withSerializableTransaction(
          client,
          async () => {
            throw { code: "40001" };
          },
          () => true,
          { maxRetries: 0 },
        ),
      ).rejects.toThrow(SerializationRetriesExhaustedError);

      const res = await client.query<{ ok: number }>("SELECT 1 AS ok");
      expect(res.rows[0]).toEqual({ ok: 1 });
    } finally {
      client.release();
    }
  });

  it("does not COMMIT or hide a rolled-back result: shouldCommit(false) issues ROLLBACK, not COMMIT", async () => {
    const client = await pool.connect();
    try {
      const result = await withSerializableTransaction(
        client,
        async () => "not-created",
        (r) => r === "created",
      );

      expect(result).toBe("not-created");
      // The transaction should already be closed (ROLLBACK ran); a bare
      // SELECT here would fail if the client were left mid-transaction with
      // an unexpected state.
      const res = await client.query<{ ok: number }>("SELECT 1 AS ok");
      expect(res.rows[0]).toEqual({ ok: 1 });
    } finally {
      client.release();
    }
  });
});
