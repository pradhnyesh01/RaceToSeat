import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb, seedEventWithSeats } from "./testDb.js";
import { startTestServer } from "./testServer.js";

describe("POST /bookings (naive strategy)", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("books an available seat", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const server = await startTestServer();

    try {
      const res = await fetch(`${server.baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seat_id: seatIdsByLabel.A1,
          user_id: "user-1",
          idempotency_key: randomUUID(),
        }),
      });
      const body = (await res.json()) as { id: string };

      expect(res.status).toBe(201);
      expect(body.id).toBeTypeOf("string");

      const seatRes = await pool.query("SELECT status, booked_by, version FROM seats WHERE id = $1", [
        seatIdsByLabel.A1,
      ]);
      expect(seatRes.rows[0]).toMatchObject({ status: "booked", booked_by: "user-1", version: 1 });
    } finally {
      await server.close();
    }
  });

  it("409s when the seat is already booked", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
    const server = await startTestServer();

    try {
      await fetch(`${server.baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seat_id: seatIdsByLabel.A1, user_id: "user-1", idempotency_key: randomUUID() }),
      });

      const res = await fetch(`${server.baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seat_id: seatIdsByLabel.A1, user_id: "user-2", idempotency_key: randomUUID() }),
      });

      expect(res.status).toBe(409);
    } finally {
      await server.close();
    }
  });

  it("404s for an unknown seat", async () => {
    const server = await startTestServer();
    try {
      const res = await fetch(`${server.baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seat_id: "00000000-0000-0000-0000-000000000000",
          user_id: "user-1",
          idempotency_key: randomUUID(),
        }),
      });
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("400s when a required field is missing", async () => {
    const server = await startTestServer();
    try {
      const res = await fetch(`${server.baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: "user-1" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("replays the same booking for a duplicate idempotency_key instead of creating a second one", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
    const server = await startTestServer();
    const idempotencyKey = randomUUID();

    try {
      const first = await fetch(`${server.baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seat_id: seatIdsByLabel.A1, user_id: "user-1", idempotency_key: idempotencyKey }),
      });
      const firstBody = (await first.json()) as { id: string };

      // Same idempotency_key, different seat: must not create a second booking.
      const second = await fetch(`${server.baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seat_id: seatIdsByLabel.A2, user_id: "user-1", idempotency_key: idempotencyKey }),
      });
      const secondBody = (await second.json()) as { id: string };

      expect(second.status).toBe(200);
      expect(secondBody.id).toBe(firstBody.id);

      const countRes = await pool.query("SELECT count(*)::int AS count FROM bookings");
      expect(countRes.rows[0].count).toBe(1);

      const seatA2 = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A2]);
      expect(seatA2.rows[0].status).toBe("available");
    } finally {
      await server.close();
    }
  });
});
