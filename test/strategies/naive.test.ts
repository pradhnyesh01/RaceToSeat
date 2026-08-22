process.env.BOOKING_STRATEGY = "naive";

const { createApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/pool.js");
const { runBookingConcurrencyContractTest, runBookingContractTests } = await import("../bookingContract.js");

const { afterAll } = await import("vitest");

afterAll(() => pool.end());

runBookingContractTests("naive", createApp);
runBookingConcurrencyContractTest("naive", createApp);
