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

  // Issue #29: a deadlock abort (40P01) is retriable here too, on the same
  // counter/cap/backoff as a genuine serialization failure — no separate
  // withDeadlockRetry wrapper (that's naive's/unique_constraint's/
  // optimistic's shape, ADR-0014; nesting it here would double-BEGIN).
  it("retries on a synthetic deadlock abort (40P01), same as a serialization failure", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;
      const failuresBeforeSuccess = 2;

      const result = await withSerializableTransaction(client, async () => {
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

  it("retries across a mix of 40001 and 40P01 on the same attempt counter", async () => {
    const client = await pool.connect();
    try {
      const codesThrown: string[] = ["40001", "40P01", "40001"];
      let calls = 0;

      const result = await withSerializableTransaction(client, async () => {
        const code = codesThrown[calls];
        calls++;
        if (code) {
          throw { code };
        }
        return "ok";
      });

      expect(result).toBe("ok");
      expect(calls).toBe(codesThrown.length + 1);
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

  it("throws SerializationRetriesExhaustedError after exhausting the retry cap on repeated deadlock aborts too", async () => {
    const client = await pool.connect();
    try {
      let calls = 0;

      const rejection = withSerializableTransaction(
        client,
        async () => {
          calls++;
          throw { code: "40P01" };
        },
        () => true,
        { maxRetries: 2 },
      );

      await expect(rejection).rejects.toThrow(SerializationRetriesExhaustedError);
      expect(calls).toBe(3);
    } finally {
      client.release();
    }
  });

  // Issue #59 (R6, ADR-0028): a total time budget alongside the retry-count cap. Under a slow
  // link every attempt costs many round trips, so five count-capped retries can outlast the
  // client's own timeout; the loop therefore also stops starting attempts it predicts would
  // finish past the budget. The prediction is the last failed attempt's own duration.
  describe("retry time budget (R6)", () => {
    const slowAttempt = (calls: { n: number }, ms: number) => async () => {
      calls.n++;
      await new Promise((resolve) => setTimeout(resolve, ms));
      throw { code: "40001" };
    };

    it("stops starting attempts once another one would overrun the budget, well before the count cap", async () => {
      const client = await pool.connect();
      try {
        const calls = { n: 0 };
        const started = Date.now();

        const rejection = withSerializableTransaction(client, slowAttempt(calls, 100), () => true, {
          maxRetries: 50,
          budgetMs: 250,
        });

        await expect(rejection).rejects.toThrow(SerializationRetriesExhaustedError);
        const elapsed = Date.now() - started;
        // attempt 0 ends ~100 ms (100 + 100 <= 250: retry), attempt 1 ends ~200 ms
        // (200 + 100 > 250: stop). Two attempts, one retry, bounded by the budget.
        expect(calls.n).toBe(2);
        expect(elapsed).toBeLessThan(250 + 150);
      } finally {
        client.release();
      }
    });

    it("reports the retries actually made, so retry_exhausted still carries a true retry count", async () => {
      const client = await pool.connect();
      try {
        const calls = { n: 0 };
        const error = await withSerializableTransaction(client, slowAttempt(calls, 100), () => true, {
          maxRetries: 50,
          budgetMs: 250,
        }).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(SerializationRetriesExhaustedError);
        expect((error as SerializationRetriesExhaustedError).retries).toBe(1);
      } finally {
        client.release();
      }
    });

    it("always makes the first attempt, even when it alone is longer than the budget", async () => {
      const client = await pool.connect();
      try {
        const calls = { n: 0 };
        await expect(
          withSerializableTransaction(client, slowAttempt(calls, 60), () => true, { maxRetries: 5, budgetMs: 1 }),
        ).rejects.toThrow(SerializationRetriesExhaustedError);
        expect(calls.n).toBe(1);
      } finally {
        client.release();
      }
    });

    it("does not interfere when attempts are fast: the count cap still decides", async () => {
      const client = await pool.connect();
      try {
        const calls = { n: 0 };
        await expect(
          withSerializableTransaction(client, slowAttempt(calls, 1), () => true, { maxRetries: 4, budgetMs: 60_000 }),
        ).rejects.toThrow(SerializationRetriesExhaustedError);
        expect(calls.n).toBe(5);
      } finally {
        client.release();
      }
    });

    it("a budget never turns a success into a failure: the attempt that fits is allowed to finish", async () => {
      const client = await pool.connect();
      try {
        let calls = 0;
        const result = await withSerializableTransaction(
          client,
          async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (calls === 1) throw { code: "40001" };
            return "ok";
          },
          () => true,
          { maxRetries: 5, budgetMs: 1000 },
        );
        expect(result).toBe("ok");
        expect(calls).toBe(2);
      } finally {
        client.release();
      }
    });
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
