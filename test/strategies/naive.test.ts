process.env.BOOKING_STRATEGY = "naive";

const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const {
  runBookingConcurrencyContractTest,
  runBookingContractTests,
  runCrossSeatIsolationContractTest,
  runIdempotencyKeyRaceContractTests,
  runIdempotencyKeyReleaseContractTest,
  runMultiSeatBookingContractTests,
} = await import("../bookingContract.js");

const { afterAll } = await import("vitest");

afterAll(() => pool.end());

runBookingContractTests("naive", createApp);
runBookingConcurrencyContractTest("naive", createApp);
runMultiSeatBookingContractTests("naive", createApp);
runIdempotencyKeyReleaseContractTest("naive", createApp);
runIdempotencyKeyRaceContractTests("naive", createApp);

// Holds naive's own write statement — the UPDATE seats SET status = 'booked'
// ... it runs once its (unguarded) availability read passes — open and
// uncommitted against `lockSeatId` on a separate connection. Naive takes no
// explicit lock at read time (that's the whole point of "naive"), so this
// write is the only real row lock it ever holds; standing it up directly,
// rather than driving a second in-flight request through the app, keeps the
// hold deterministic. Rolled back, not committed: this is a synthetic
// in-flight writer, not a booking meant to persist.
async function withOpenSeatUpdate<T>(lockSeatId: string, fn: () => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  await lockClient.query("BEGIN");
  await lockClient.query(
    "UPDATE seats SET status = 'booked', booked_by = 'lock-holder', version = version + 1 WHERE id = $1",
    [lockSeatId],
  );
  try {
    return await fn();
  } finally {
    await lockClient.query("ROLLBACK");
    lockClient.release();
  }
}

runCrossSeatIsolationContractTest("naive", createApp, withOpenSeatUpdate);
