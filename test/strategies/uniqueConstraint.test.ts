process.env.BOOKING_STRATEGY = "unique_constraint";

const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const { runBookingConcurrencyContractTest, runBookingContractTests, runMultiSeatBookingContractTests } =
  await import("../bookingContract.js");

const { afterAll } = await import("vitest");

afterAll(() => pool.end());

runBookingContractTests("unique_constraint", createApp);
runBookingConcurrencyContractTest("unique_constraint", createApp);
runMultiSeatBookingContractTests("unique_constraint", createApp);
