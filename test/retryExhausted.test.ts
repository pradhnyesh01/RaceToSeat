import { describe, expect, it, vi } from "vitest";

// No mechanism produces retry_exhausted yet (that lands with the optimistic
// and serializable strategies) — this proves the route's mapping in
// isolation by stubbing bookSeat directly, rather than waiting on either.
vi.mock("../src/strategies/index.js", () => ({
  bookSeat: vi.fn().mockResolvedValue({ kind: "retry_exhausted", retries: 3 }),
}));

const { createApp } = await import("../src/app.js");

describe("POST /bookings — retry_exhausted mapping", () => {
  it("maps a retry_exhausted result to 503 with the retry count on the header", async () => {
    const app = createApp();

    const res = await app.inject({
      method: "POST",
      url: "/bookings",
      payload: {
        seat_id: "00000000-0000-0000-0000-000000000000",
        user_id: "user-1",
        idempotency_key: "key-1",
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers["x-booking-retries"]).toBe("3");
  });
});
