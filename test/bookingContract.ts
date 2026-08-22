import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb, seedEventWithSeats } from "./testDb.js";

// Shared behavioural contract every booking strategy must satisfy,
// parameterized so each mechanism's thin test file (naive, unique_constraint,
// pessimistic, ...) exercises the exact same seam: HTTP in, HTTP + DB state
// out. Pool teardown is the calling file's responsibility (one file-scoped
// afterAll), since this helper may run alongside other describe blocks
// sharing the same pool within a file.
export function runBookingContractTests(strategyLabel: string, createApp: () => FastifyInstance): void {
  describe(`POST /bookings (${strategyLabel} strategy)`, () => {
    beforeEach(resetDb);

    it("books an available seat", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();

      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatIdsByLabel.A1, user_id: "user-1", idempotency_key: randomUUID() },
      });
      const body = res.json() as { id: string };

      expect(res.statusCode).toBe(201);
      expect(body.id).toBeTypeOf("string");

      const seatRes = await pool.query("SELECT status, booked_by, version FROM seats WHERE id = $1", [
        seatIdsByLabel.A1,
      ]);
      expect(seatRes.rows[0]).toMatchObject({ status: "booked", booked_by: "user-1", version: 1 });

      // The write must go through booking_seats (ADR-0005), not just seats.booked_by.
      const bookingSeatsRes = await pool.query(
        "SELECT booking_id FROM booking_seats WHERE seat_id = $1",
        [seatIdsByLabel.A1],
      );
      expect(bookingSeatsRes.rows).toHaveLength(1);
      expect(bookingSeatsRes.rows[0].booking_id).toBe(body.id);
    });

    it("409s when the seat is already booked", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();

      await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatIdsByLabel.A1, user_id: "user-1", idempotency_key: randomUUID() },
      });

      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatIdsByLabel.A1, user_id: "user-2", idempotency_key: randomUUID() },
      });

      expect(res.statusCode).toBe(409);
    });

    it("404s for an unknown seat", async () => {
      const app = createApp();
      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: {
          seat_id: "00000000-0000-0000-0000-000000000000",
          user_id: "user-1",
          idempotency_key: randomUUID(),
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it("400s when a required field is missing", async () => {
      const app = createApp();
      const res = await app.inject({ method: "POST", url: "/bookings", payload: { user_id: "user-1" } });
      expect(res.statusCode).toBe(400);
    });

    it("returns the same booking id and 201 when the identical request is sent twice", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const payload = { seat_id: seatIdsByLabel.A1, user_id: "user-1", idempotency_key: randomUUID() };

      const first = await app.inject({ method: "POST", url: "/bookings", payload });
      const second = await app.inject({ method: "POST", url: "/bookings", payload });

      const firstBody = first.json() as { id: string };
      const secondBody = second.json() as { id: string };

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(secondBody.id).toBe(firstBody.id);

      const bookingSeatsRes = await pool.query(
        "SELECT booking_id FROM booking_seats WHERE seat_id = $1",
        [seatIdsByLabel.A1],
      );
      expect(bookingSeatsRes.rows).toHaveLength(1);
    });

    it("replays the same booking for a duplicate idempotency_key instead of creating a second one", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
      const app = createApp();
      const idempotencyKey = randomUUID();

      const first = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatIdsByLabel.A1, user_id: "user-1", idempotency_key: idempotencyKey },
      });
      const firstBody = first.json() as { id: string };

      // Same idempotency_key, different seat: must not create a second booking.
      const second = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_id: seatIdsByLabel.A2, user_id: "user-1", idempotency_key: idempotencyKey },
      });
      const secondBody = second.json() as { id: string };

      expect(second.statusCode).toBe(201);
      expect(secondBody.id).toBe(firstBody.id);

      const countRes = await pool.query("SELECT count(*)::int AS count FROM bookings");
      expect(countRes.rows[0].count).toBe(1);

      const seatA2 = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A2]);
      expect(seatA2.rows[0].status).toBe("available");
    });
  });
}

// Every mechanism's central claim: under real concurrency at one seat,
// exactly one request wins. Separate from runBookingContractTests since it's
// the one test whose point is exercising genuine contention, not just HTTP
// behavior for a single request at a time.
export function runBookingConcurrencyContractTest(strategyLabel: string, createApp: () => FastifyInstance): void {
  describe(`POST /bookings (${strategyLabel} strategy) — concurrency`, () => {
    beforeEach(resetDb);

    it("under concurrent requests for one seat, exactly one 201 and the rest 409 — never 500", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const concurrency = 25;

      const responses = await Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/bookings",
            payload: { seat_id: seatIdsByLabel.A1, user_id: `user-${i}`, idempotency_key: `race-${i}` },
          }),
        ),
      );

      const statusCounts = responses.reduce<Record<number, number>>((counts, res) => {
        counts[res.statusCode] = (counts[res.statusCode] ?? 0) + 1;
        return counts;
      }, {});

      expect(statusCounts[201]).toBe(1);
      expect(statusCounts[409]).toBe(concurrency - 1);
      expect(statusCounts[500]).toBeUndefined();

      const bookingSeatsRes = await pool.query(
        "SELECT booking_id FROM booking_seats WHERE seat_id = $1",
        [seatIdsByLabel.A1],
      );
      expect(bookingSeatsRes.rows).toHaveLength(1);
    });
  });
}
