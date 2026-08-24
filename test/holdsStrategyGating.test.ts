import { randomUUID } from "node:crypto";

// The hold flow is implemented for `pessimistic` only (ADR-0017/0019) — this
// file exists specifically to prove the *other* five strategies never get
// POST /holds registered at all, so it deliberately pins something other
// than pessimistic. See cancellation.test.ts for why every top-level test
// file must pin BOOKING_STRATEGY explicitly rather than relying on
// config.ts's default: vitest.config.ts's fileParallelism: false runs every
// file sequentially in one process, and nothing resets process.env between
// them.
process.env.BOOKING_STRATEGY = "naive";

const { createApp } = await import("../src/app.js");
const { pool } = await import("../src/db/pool.js");
const { resetDb, seedEventWithSeats } = await import("./testDb.js");

const { afterAll, beforeEach, describe, expect, it } = await import("vitest");

describe("POST /holds — strategy gating", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("404s when BOOKING_STRATEGY is not pessimistic", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const app = createApp();

    const res = await app.inject({
      method: "POST",
      url: "/holds",
      payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
    });

    expect(res.statusCode).toBe(404);
  });
});
