import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb, seedEventWithSeats } from "./testDb.js";

describe("GET /seats", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("returns the seats for the given event, ordered by label", async () => {
    const { eventId } = await seedEventWithSeats(["A1", "A2", "B1"]);
    const app = createApp();

    const res = await app.inject({ method: "GET", url: `/seats?event_id=${eventId}` });
    const body = res.json() as { seats: Array<{ label: string; status: string }> };

    expect(res.statusCode).toBe(200);
    expect(body.seats.map((s) => s.label)).toEqual(["A1", "A2", "B1"]);
    expect(body.seats.every((s) => s.status === "available")).toBe(true);
  });

  it("400s when event_id is missing", async () => {
    const app = createApp();
    const res = await app.inject({ method: "GET", url: "/seats" });
    expect(res.statusCode).toBe(400);
  });
});
