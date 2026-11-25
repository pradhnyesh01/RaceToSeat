process.env.BOOKING_STRATEGY = "pessimistic";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../src/app.js");
const { pool } = await import("../src/db/pool.js");
const { runReaperSweep, startReaper } = await import("../src/reaper.js");
const { createHold, expireHold, resetDb, seedEventWithSeats, withHeldRowLock } = await import("./testDb.js");

const { afterAll, afterEach, describe, expect, it, vi } = await import("vitest");

afterAll(() => pool.end());

describe("runReaperSweep", () => {
  it("releases an expired hold's seat back to available and deletes the hold", async () => {
    await resetDb();
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const hold = await createHold(app, [seatIdsByLabel.A1!]);
    await expireHold([seatIdsByLabel.A1!]);

    await runReaperSweep(pool);

    const seatRes = await pool.query("SELECT status, booked_by, held_until, version FROM seats WHERE id = $1", [
      seatIdsByLabel.A1,
    ]);
    expect(seatRes.rows[0]).toMatchObject({ status: "available", booked_by: null, held_until: null, version: 2 });

    const holdSeatsRes = await pool.query("SELECT 1 FROM hold_seats WHERE hold_id = $1", [hold.id]);
    expect(holdSeatsRes.rows).toHaveLength(0);
    const holdsRes = await pool.query("SELECT 1 FROM holds WHERE id = $1", [hold.id]);
    expect(holdsRes.rows).toHaveLength(0);
  });

  it("releases every seat of a multi-seat expired hold and deletes the single hold row once", async () => {
    await resetDb();
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
    const app = createApp();
    const hold = await createHold(app, [seatIdsByLabel.A1!, seatIdsByLabel.A2!]);
    await expireHold([seatIdsByLabel.A1!, seatIdsByLabel.A2!]);

    await runReaperSweep(pool);

    const seatRes = await pool.query("SELECT status FROM seats WHERE id = ANY($1)", [
      [seatIdsByLabel.A1, seatIdsByLabel.A2],
    ]);
    expect(seatRes.rows.every((row) => row.status === "available")).toBe(true);

    // Duplicate hold_id rows from the two deleted hold_seats rows must
    // collapse to deleting the one holds row exactly once, not error.
    const holdsRes = await pool.query("SELECT count(*)::int AS count FROM holds WHERE id = $1", [hold.id]);
    expect(holdsRes.rows[0].count).toBe(0);
  });

  it("leaves a not-yet-expired hold untouched", async () => {
    await resetDb();
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const hold = await createHold(app, [seatIdsByLabel.A1!]);

    await runReaperSweep(pool);

    const seatRes = await pool.query("SELECT status, version FROM seats WHERE id = $1", [seatIdsByLabel.A1]);
    expect(seatRes.rows[0]).toMatchObject({ status: "held", version: 1 });

    const holdSeatsRes = await pool.query("SELECT 1 FROM hold_seats WHERE hold_id = $1", [hold.id]);
    expect(holdSeatsRes.rows).toHaveLength(1);
  });

  it("leaves booked and available seats untouched", async () => {
    await resetDb();
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
    const app = createApp();
    await app.inject({
      method: "POST",
      url: "/bookings",
      payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
    });
    // A2 stays 'available', never touched by any request in this test.

    await runReaperSweep(pool);

    const seatRes = await pool.query("SELECT label, status FROM seats WHERE id = ANY($1) ORDER BY label", [
      [seatIdsByLabel.A1, seatIdsByLabel.A2],
    ]);
    expect(seatRes.rows).toMatchObject([
      { label: "A1", status: "booked" },
      { label: "A2", status: "available" },
    ]);
  });
});

describe("startReaper", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs a sweep on each interval tick, and stops running once told to", async () => {
    vi.useFakeTimers();
    const querySpy = vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);

    const reaper = startReaper(pool, 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(querySpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(querySpy).toHaveBeenCalledTimes(3);

    reaper.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(querySpy).toHaveBeenCalledTimes(3);
  });
});

// R7 (#57): a row-locked expired seat (a slow or leaked transaction) must not
// make the sweep hold row locks on the *other* expired seats it visited, nor
// make the sweep itself wait. See docs/adr/0028.
describe("runReaperSweep with a row-locked expired seat", () => {
  const SWEEP_SETTLE_MS = 1000; // well under the pool's 1.5 s statement_timeout

  async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    return Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  }

  it("does not wait on the locked seat, and leaves other expired seats free for a NOWAIT Hold", async () => {
    await resetDb();
    // The bait is the last-seeded seat so a sweep that waits on it has
    // already taken row locks on the earlier expired seats it visited.
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2", "A3"]);
    const app = createApp();
    const a1 = seatIdsByLabel.A1!;
    const a2 = seatIdsByLabel.A2!;
    const bait = seatIdsByLabel.A3!;
    await createHold(app, [a1], "user-a1");
    await createHold(app, [a2], "user-a2");
    await createHold(app, [bait], "user-bait");
    await expireHold([a1, a2, bait]);

    await withHeldRowLock(bait, async () => {
      const sweep = runReaperSweep(pool);
      // Without the fix the sweep blocks on the bait forever (until the
      // statement timeout) while holding A1/A2's row locks.
      expect(await settlesWithin(sweep, SWEEP_SETTLE_MS)).toBe(true);
      await sweep;

      // The unlocked expired seats were reaped, so a fresh NOWAIT Hold wins.
      const res = await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [a2], user_id: "user-new", idempotency_key: randomUUID() },
      });
      expect(res.statusCode).toBe(201);

      // The bait stays held and expired: left for the next tick.
      const baitRes = await pool.query("SELECT status FROM seats WHERE id = $1", [bait]);
      expect(baitRes.rows[0].status).toBe("held");
    });

    // Lock released: the next sweep reaps the bait.
    await runReaperSweep(pool);
    const after = await pool.query("SELECT status FROM seats WHERE id = $1", [bait]);
    expect(after.rows[0].status).toBe("available");
    const leftovers = await pool.query("SELECT count(*)::int AS n FROM hold_seats WHERE seat_id = $1", [bait]);
    expect(leftovers.rows[0].n).toBe(0);
  });

  it("reaps a multi-seat hold all-or-nothing: one locked seat leaves the whole hold intact", async () => {
    await resetDb();
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2", "A3"]);
    const app = createApp();
    const a1 = seatIdsByLabel.A1!;
    const a2 = seatIdsByLabel.A2!;
    const a3 = seatIdsByLabel.A3!;
    const multi = await createHold(app, [a1, a2]);
    await createHold(app, [a3], "user-other");
    await expireHold([a1, a2, a3]);

    await withHeldRowLock(a2, async () => {
      // Must not violate hold_seats' foreign key on holds, nor strand a
      // half-reaped hold (A1 reset while A2 stays held under the same hold).
      await runReaperSweep(pool);

      const seats = await pool.query("SELECT label, status FROM seats WHERE id = ANY($1) ORDER BY label", [
        [a1, a2, a3],
      ]);
      expect(seats.rows).toMatchObject([
        { label: "A1", status: "held" },
        { label: "A2", status: "held" },
        { label: "A3", status: "available" },
      ]);
      const hs = await pool.query("SELECT count(*)::int AS n FROM hold_seats WHERE hold_id = $1", [multi.id]);
      expect(hs.rows[0].n).toBe(2);
    });

    await runReaperSweep(pool);
    const seats = await pool.query("SELECT status FROM seats WHERE id = ANY($1)", [[a1, a2, a3]]);
    expect(seats.rows.every((r) => r.status === "available")).toBe(true);
    const holds = await pool.query("SELECT count(*)::int AS n FROM holds WHERE id = $1", [multi.id]);
    expect(holds.rows[0].n).toBe(0);
  });
});
