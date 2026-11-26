// RF1 (issue #60, ADR-0030): the retention machinery behind "an Idempotency Key outlives its
// Booking/Hold" - what the tombstone holds, the insert-time guard that closes the lookup-then-
// insert window, the retention horizon, the pruner, and how confirm's synthesized key retires.
// The user-visible book -> cancel -> retry and hold -> expire -> reap -> retry flows are the
// shared contract tests (bookingContract.ts / holdContract.ts), run for every mechanism; this
// file pins the pieces underneath them, against `pessimistic` because the hold flow is
// pessimistic-only (ADR-0017).
process.env.BOOKING_STRATEGY = "pessimistic";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const { pool } = await import("../src/db/pool.js");
const { pruneExpiredTombstones } = await import("../src/db/tombstones.js");
const { createHold, expireHold, interceptQuery, resetDb, seedEventWithSeats } = await import("./testDb.js");
const { runReaperSweep } = await import("../src/reaper.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());
beforeEach(resetDb);

async function bookAndCancel(app: ReturnType<typeof createApp>, seatId: string, key: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/bookings",
    payload: { seat_ids: [seatId], user_id: "user-1", idempotency_key: key },
  });
  const { id } = res.json() as { id: string };
  expect((await app.inject({ method: "DELETE", url: `/bookings/${id}` })).statusCode).toBe(204);
  return id;
}

describe("the tombstone a release leaves behind", () => {
  it("records what the key created, why it was released, and a retention horizon", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const key = randomUUID();
    const before = Date.now();

    const bookingId = await bookAndCancel(app, seatIdsByLabel.A1!, key);

    const res = await pool.query<{ kind: string; resource_id: string; reason: string; expires_at: Date; released_at: Date }>(
      "SELECT kind, resource_id, reason, expires_at, released_at FROM idempotency_tombstones WHERE idempotency_key = $1",
      [key],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ kind: "booking", resource_id: bookingId, reason: "cancelled" });
    const retentionMs = res.rows[0]!.expires_at.getTime() - res.rows[0]!.released_at.getTime();
    expect(retentionMs).toBe(config.idempotencyRetentionSeconds * 1000);
    expect(res.rows[0]!.released_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("is written for a reaped hold (expired) and a confirmed hold (confirmed), keyed by the hold's own key", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "B1"]);
    const app = createApp();
    const reapedKey = randomUUID();
    const confirmedKey = randomUUID();
    const reaped = (
      await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "u", idempotency_key: reapedKey },
      })
    ).json() as { id: string };
    const confirmed = (
      await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.B1], user_id: "u", idempotency_key: confirmedKey },
      })
    ).json() as { id: string };
    await app.inject({ method: "POST", url: `/holds/${confirmed.id}/confirm` });
    await expireHold([seatIdsByLabel.A1!]);
    await runReaperSweep(pool);

    const res = await pool.query<{ idempotency_key: string; kind: string; resource_id: string; reason: string }>(
      "SELECT idempotency_key, kind, resource_id, reason FROM idempotency_tombstones ORDER BY reason",
    );
    expect(res.rows).toEqual([
      { idempotency_key: confirmedKey, kind: "hold", resource_id: confirmed.id, reason: "confirmed" },
      { idempotency_key: reapedKey, kind: "hold", resource_id: reaped.id, reason: "expired" },
    ]);
  });

  it("is not written while the booking or hold is still live (no extra write on the happy path)", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "B1"]);
    const app = createApp();
    await app.inject({
      method: "POST",
      url: "/bookings",
      payload: { seat_ids: [seatIdsByLabel.A1], user_id: "u", idempotency_key: randomUUID() },
    });
    await createHold(app, [seatIdsByLabel.B1!]);

    const res = await pool.query("SELECT 1 FROM idempotency_tombstones");
    expect(res.rows).toHaveLength(0);
  });

  it("keeps booking keys and hold keys in separate namespaces, as the two UNIQUE columns always did", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "B1"]);
    const app = createApp();
    const shared = randomUUID();
    await bookAndCancel(app, seatIdsByLabel.A1!, shared);

    const hold = await app.inject({
      method: "POST",
      url: "/holds",
      payload: { seat_ids: [seatIdsByLabel.B1], user_id: "u", idempotency_key: shared },
    });

    expect(hold.statusCode).toBe(201);
  });
});

describe("the insert-time guard (closes the lookup-then-insert window)", () => {
  it("rejects a direct INSERT of a tombstoned booking key with a unique violation naming the tombstone constraint", async () => {
    const key = randomUUID();
    await pool.query(
      "INSERT INTO idempotency_tombstones (kind, idempotency_key, resource_id, reason, expires_at) VALUES ('booking', $1, $2, 'cancelled', now() + interval '1 hour')",
      [key, randomUUID()],
    );

    await expect(pool.query("INSERT INTO bookings (user_id, idempotency_key) VALUES ('u', $1)", [key])).rejects.toMatchObject({
      code: "23505",
      constraint: "idempotency_tombstones_pkey",
    });
  });

  it("rejects a tombstoned hold key the same way, and only on its own kind", async () => {
    const key = randomUUID();
    await pool.query(
      "INSERT INTO idempotency_tombstones (kind, idempotency_key, resource_id, reason, expires_at) VALUES ('hold', $1, $2, 'expired', now() + interval '1 hour')",
      [key, randomUUID()],
    );

    await expect(pool.query("INSERT INTO holds (idempotency_key) VALUES ($1)", [key])).rejects.toMatchObject({
      code: "23505",
      constraint: "idempotency_tombstones_pkey",
    });
    // Same string as a *booking* key is a different namespace.
    await expect(pool.query("INSERT INTO bookings (user_id, idempotency_key) VALUES ('u', $1)", [key])).resolves.toBeDefined();
  });

  it("answers 410 for a booking whose key is tombstoned between its lookup and its insert (the window the lookup alone leaves open)", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const key = randomUUID();
    const releasedId = randomUUID();

    // The retry's own key lookup finds nothing; right after it, a concurrent same-key attempt
    // completes its whole lifecycle (book, commit, cancel) - which is exactly "a tombstone
    // committed" - and only then does the retry reach its INSERT.
    const intercept = interceptQuery(
      "SELECT 'live'",
      async (connect) => {
        const other = await connect();
        try {
          await other.query(
            "INSERT INTO idempotency_tombstones (kind, idempotency_key, resource_id, reason, expires_at) VALUES ('booking', $1, $2, 'cancelled', now() + interval '1 hour')",
            [key, releasedId],
          );
        } finally {
          other.release();
        }
      },
      (result) => (result as { rows: unknown[] }).rows.length === 0,
    );
    let res;
    try {
      res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "u", idempotency_key: key },
      });
    } finally {
      intercept.restore();
    }

    expect(intercept.wasTriggered()).toBe(true);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ outcome: "key_released", reason: "cancelled", released_id: releasedId });
    expect((await pool.query("SELECT 1 FROM bookings")).rows).toHaveLength(0);
    expect((await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A1])).rows[0]).toMatchObject({
      status: "available",
    });
  });

  it("answers 410 for a hold whose key is tombstoned between its lookup and its insert", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const key = randomUUID();
    const releasedId = randomUUID();

    const intercept = interceptQuery(
      "SELECT 'live'",
      async (connect) => {
        const other = await connect();
        try {
          await other.query(
            "INSERT INTO idempotency_tombstones (kind, idempotency_key, resource_id, reason, expires_at) VALUES ('hold', $1, $2, 'expired', now() + interval '1 hour')",
            [key, releasedId],
          );
        } finally {
          other.release();
        }
      },
      (result) => (result as { rows: unknown[] }).rows.length === 0,
    );
    let res;
    try {
      res = await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "u", idempotency_key: key },
      });
    } finally {
      intercept.restore();
    }

    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ outcome: "key_released", reason: "expired", released_id: releasedId });
    expect((await pool.query("SELECT 1 FROM holds")).rows).toHaveLength(0);
    expect((await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A1])).rows[0]).toMatchObject({
      status: "available",
    });
  });
});

describe("the retention horizon", () => {
  it("treats a key as new once its tombstone has expired, and refreshes the stale tombstone on the next release", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const key = randomUUID();
    const firstId = await bookAndCancel(app, seatIdsByLabel.A1!, key);
    await pool.query("UPDATE idempotency_tombstones SET expires_at = now() - interval '1 second' WHERE idempotency_key = $1", [key]);

    // Past retention: the bounded-window caveat in the glossary - this is a brand-new attempt.
    const reused = await app.inject({
      method: "POST",
      url: "/bookings",
      payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: key },
    });
    expect(reused.statusCode).toBe(201);
    const secondId = (reused.json() as { id: string }).id;
    expect(secondId).not.toBe(firstId);

    // Cancelling it must not trip over the not-yet-pruned stale tombstone (ON CONFLICT refresh).
    expect((await app.inject({ method: "DELETE", url: `/bookings/${secondId}` })).statusCode).toBe(204);
    const res = await pool.query<{ resource_id: string; live: boolean }>(
      "SELECT resource_id, expires_at > now() AS live FROM idempotency_tombstones WHERE idempotency_key = $1",
      [key],
    );
    expect(res.rows).toEqual([{ resource_id: secondId, live: true }]);
  });

  it("prunes only expired tombstones", async () => {
    const live = randomUUID();
    const dead = randomUUID();
    await pool.query(
      `INSERT INTO idempotency_tombstones (kind, idempotency_key, resource_id, reason, expires_at) VALUES
         ('booking', $1, $3, 'cancelled', now() + interval '1 hour'),
         ('booking', $2, $4, 'cancelled', now() - interval '1 hour')`,
      [live, dead, randomUUID(), randomUUID()],
    );

    const pruned = await pruneExpiredTombstones(pool);

    expect(pruned).toBe(1);
    const left = await pool.query<{ idempotency_key: string }>("SELECT idempotency_key FROM idempotency_tombstones");
    expect(left.rows).toEqual([{ idempotency_key: live }]);
  });
});

describe("confirm's synthesized key (hold-confirm:<id>)", () => {
  it("needs no special retirement: a confirm retried after its booking was cancelled is still 404, not 410", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const hold = await createHold(app, [seatIdsByLabel.A1!]);
    const confirm = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });
    expect(confirm.statusCode).toBe(201);
    const { id: bookingId } = confirm.json() as { id: string };
    expect((await app.inject({ method: "DELETE", url: `/bookings/${bookingId}` })).statusCode).toBe(204);

    const retry = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });

    // The hold id is a capability that was resolved; there is no hold to confirm. Same answer a
    // confirm of any already-resolved hold id gave before this change.
    expect(retry.statusCode).toBe(404);
  });

  it("still replays a retried confirm of a live-then-confirmed hold while its booking exists", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const hold = await createHold(app, [seatIdsByLabel.A1!]);
    const first = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });

    const retry = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });

    expect(retry.statusCode).toBe(201);
    expect((retry.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
  });
});
