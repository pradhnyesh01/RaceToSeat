import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb, seedEventWithSeats } from "./testDb.js";
import { startTestServer } from "./testServer.js";

describe("GET /seats", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("returns the seats for the given event, ordered by label", async () => {
    const { eventId } = await seedEventWithSeats(["A1", "A2", "B1"]);
    const server = await startTestServer();

    try {
      const res = await fetch(`${server.baseUrl}/seats?event_id=${eventId}`);
      const body = (await res.json()) as { seats: Array<{ label: string; status: string }> };

      expect(res.status).toBe(200);
      expect(body.seats.map((s: { label: string }) => s.label)).toEqual(["A1", "A2", "B1"]);
      expect(body.seats.every((s: { status: string }) => s.status === "available")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("400s when event_id is missing", async () => {
    const server = await startTestServer();
    try {
      const res = await fetch(`${server.baseUrl}/seats`);
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
