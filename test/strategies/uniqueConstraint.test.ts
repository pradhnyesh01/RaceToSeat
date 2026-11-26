process.env.BOOKING_STRATEGY = "unique_constraint";

const { randomUUID } = await import("node:crypto");
const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const {
  runBookingConcurrencyContractTest,
  runBookingContractTests,
  runCrossSeatIsolationContractTest,
  runIdempotencyKeyReleaseContractTest,
  runMultiSeatBookingContractTests,
} = await import("../bookingContract.js");

const { afterAll } = await import("vitest");

afterAll(() => pool.end());

runBookingContractTests("unique_constraint", createApp);
runBookingConcurrencyContractTest("unique_constraint", createApp);
runMultiSeatBookingContractTests("unique_constraint", createApp);
runIdempotencyKeyReleaseContractTest("unique_constraint", createApp);

// Holds this mechanism's own distinguishing write — the INSERT INTO
// booking_seats ... ON CONFLICT (seat_id) DO NOTHING that is the sole
// arbiter of win/loss here (unlike naive, there's no separate availability
// read to race) — open and uncommitted against `lockSeatId` on a separate
// connection, standing in for another in-flight unique_constraint booking
// mid-transaction. Rolled back, not committed: a synthetic in-flight writer,
// not a booking meant to persist.
async function withOpenBookingSeatInsert<T>(lockSeatId: string, fn: () => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  await lockClient.query("BEGIN");
  const bookingRes = await lockClient.query<{ id: string }>(
    "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id",
    ["lock-holder", `cross-seat-hold-${randomUUID()}`],
  );
  await lockClient.query(
    "INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2) ON CONFLICT (seat_id) DO NOTHING",
    [bookingRes.rows[0]!.id, lockSeatId],
  );
  try {
    return await fn();
  } finally {
    await lockClient.query("ROLLBACK");
    lockClient.release();
  }
}

runCrossSeatIsolationContractTest("unique_constraint", createApp, withOpenBookingSeatInsert);
