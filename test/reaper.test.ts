process.env.BOOKING_STRATEGY = "pessimistic";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../src/app.js");
const { pool } = await import("../src/db/pool.js");
const { runReaperSweep, startReaper } = await import("../src/reaper.js");
const { createHold, expireHold, resetDb, seedEventWithSeats } = await import("./testDb.js");

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
