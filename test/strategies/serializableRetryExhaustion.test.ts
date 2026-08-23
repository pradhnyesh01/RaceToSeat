process.env.BOOKING_STRATEGY = "serializable";
// Forces the retry cap to 0 (ADR-0011's default is 5) so the deterministic
// race below drives the losing request straight to retry_exhausted instead
// of retrying to discover the seat was taken.
process.env.SERIALIZABLE_MAX_RETRIES = "0";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const { commitBookingOnClient, interceptQuery, resetDb, seedEventWithSeats } = await import("../testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

afterAll(() => pool.end());

describe("POST /bookings (serializable strategy, max retries = 0) — retry exhaustion", () => {
  beforeEach(resetDb);

  it("a request that genuinely loses a SERIALIZABLE conflict gets 503 retry_exhausted, not 409", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const seatId = seatIdsByLabel.A1!;
    const app = createApp();

    // A plain concurrent Promise.all race is unreliable here: Postgres only
    // raises a genuine 40001 for a transaction whose read of the seat
    // happened *before* the winner's commit — a "late starter" whose own
    // SELECT runs after the winner already committed just sees 'booked'
    // directly and returns an ordinary conflict, no exception involved
    // (confirmed empirically: repeated 25-way races produced anywhere from
    // 0 to 4 genuine 40001s out of 24 losers, never a reliable count). So
    // instead we intercept the mechanism's own client: right after its
    // status read (still 'available', establishing this transaction's
    // SERIALIZABLE read dependency), a second, fully independent connection
    // commits a real, complete booking for the same seat. When the
    // intercepted request then attempts its own write, it collides with
    // that already-committed write and Postgres raises a genuine 40001 —
    // not a stub, a real serialization failure.
    const interceptor = interceptQuery("SELECT id, status FROM seats", async (connect) => {
      const winnerClient = await connect();
      try {
        // Must also be SERIALIZABLE, not just committed — see
        // withSerializableTransaction's doc comment in src/db/pool.ts:
        // Postgres's SSI conflict detection (the source of a genuine 40001)
        // only tracks read/write dependencies between transactions that are
        // themselves SERIALIZABLE. A plain READ COMMITTED winner (as used
        // in the counter-case in serializable.test.ts) would instead
        // reliably produce an ordinary 23505 for the loser.
        await winnerClient.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await commitBookingOnClient(winnerClient, seatId, "winner");
        await winnerClient.query("COMMIT");
      } finally {
        winnerClient.release();
      }
    });

    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_ids: [seatId], user_id: "user-1", idempotency_key: randomUUID() },
      });
    } finally {
      interceptor.restore();
    }

    expect(interceptor.wasTriggered()).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.headers["x-booking-retries"]).toBe("0");
    expect(res.json()).toMatchObject({ error: expect.any(String) });

    const seatRow = await pool.query("SELECT status, booked_by FROM seats WHERE id = $1", [seatId]);
    expect(seatRow.rows[0]).toMatchObject({ status: "booked", booked_by: "winner" });
  });

  it("under a real 25-way race with the cap forced to 0, every loser is a clean 409 or 503, never a 500", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();
    const concurrency = 25;

    // Unlike the deterministic test above, this doesn't stage which requests
    // hit a genuine 40001 vs. cleanly observe 'booked' after the winner
    // commits — that split is inherently timing-dependent for this
    // mechanism (see the comment above). This test only asserts the
    // invariant that holds regardless of that split: exactly one winner,
    // and every loser resolves to a real outcome, never an uncaught error.
    const responses = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/bookings",
          payload: { seat_ids: [seatIdsByLabel.A1], user_id: `user-${i}`, idempotency_key: `race-${i}` },
        }),
      ),
    );

    const statusCounts = responses.reduce<Record<number, number>>((counts, res) => {
      counts[res.statusCode] = (counts[res.statusCode] ?? 0) + 1;
      return counts;
    }, {});

    expect(statusCounts[201]).toBe(1);
    expect((statusCounts[409] ?? 0) + (statusCounts[503] ?? 0)).toBe(concurrency - 1);
    expect(statusCounts[500]).toBeUndefined();

    const bookingSeatsRes = await pool.query(
      "SELECT booking_id FROM booking_seats WHERE seat_id = $1",
      [seatIdsByLabel.A1],
    );
    expect(bookingSeatsRes.rows).toHaveLength(1);
  });
});
