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
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
      });
      const body = res.json() as { id: string };

      expect(res.statusCode).toBe(201);
      expect(body.id).toBeTypeOf("string");
      // Every mechanism carries this header (ADR-0012); naive, unique_constraint,
      // pessimistic, and advisory never retry, so it must always read "0" for them.
      expect(res.headers["x-booking-retries"]).toBe("0");

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
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
      });

      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-2", idempotency_key: randomUUID() },
      });

      expect(res.statusCode).toBe(409);
      expect(res.headers["x-booking-retries"]).toBe("0");
    });

    it("404s for an unknown seat", async () => {
      const app = createApp();
      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: {
          seat_ids: ["00000000-0000-0000-0000-000000000000"],
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
      const payload = { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() };

      const first = await app.inject({ method: "POST", url: "/bookings", payload });
      const second = await app.inject({ method: "POST", url: "/bookings", payload });

      const firstBody = first.json() as { id: string };
      const secondBody = second.json() as { id: string };

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(secondBody.id).toBe(firstBody.id);
      expect(second.headers["x-booking-retries"]).toBe("0");

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
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: idempotencyKey },
      });
      const firstBody = first.json() as { id: string };

      // Same idempotency_key, different seat: must not create a second booking.
      const second = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_ids: [seatIdsByLabel.A2], user_id: "user-1", idempotency_key: idempotencyKey },
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

// Shared multi-seat HTTP contract (Phase 3, issue #24): all-or-nothing,
// duplicate-seat 400, and 404-before-409 precedence — mirroring
// runBookingContractTests' pattern so a future fix to this contract doesn't
// need six copy-pasted edits. Deliberately no concurrency/ordering/deadlock
// coverage here (that's the deadlock-harness ticket's job, issue #25) — every
// request below is a single, sequential HTTP call.
export function runMultiSeatBookingContractTests(strategyLabel: string, createApp: () => FastifyInstance): void {
  describe(`POST /bookings (${strategyLabel} strategy) — multi-seat`, () => {
    beforeEach(resetDb);

    it("books multiple available seats in one request", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
      const app = createApp();

      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: {
          seat_ids: [seatIdsByLabel.A1, seatIdsByLabel.A2],
          user_id: "user-1",
          idempotency_key: randomUUID(),
        },
      });
      const body = res.json() as { id: string; created_at: string };

      expect(res.statusCode).toBe(201);
      // The 201 body shape is unchanged regardless of seat count (spec):
      // {id, created_at}, never a per-seat list.
      expect(Object.keys(body).sort()).toEqual(["created_at", "id"]);

      const seatRes = await pool.query("SELECT status FROM seats WHERE id = ANY($1)", [
        [seatIdsByLabel.A1, seatIdsByLabel.A2],
      ]);
      expect(seatRes.rows.every((row) => row.status === "booked")).toBe(true);

      const bookingSeatsRes = await pool.query("SELECT seat_id FROM booking_seats WHERE booking_id = $1", [
        body.id,
      ]);
      expect(bookingSeatsRes.rows).toHaveLength(2);
    });

    it("400s when seat_ids contains a duplicate", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();

      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: {
          seat_ids: [seatIdsByLabel.A1, seatIdsByLabel.A1],
          user_id: "user-1",
          idempotency_key: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("400s when seat_ids contains the same seat spelled with different UUID casing", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();

      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: {
          seat_ids: [seatIdsByLabel.A1, seatIdsByLabel.A1!.toUpperCase()],
          user_id: "user-1",
          idempotency_key: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("is all-or-nothing: one seat already booked fails the whole request, leaving the other seat untouched", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
      const app = createApp();

      await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
      });

      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: {
          seat_ids: [seatIdsByLabel.A2, seatIdsByLabel.A1],
          user_id: "user-2",
          idempotency_key: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(409);

      const seatA2 = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A2]);
      expect(seatA2.rows[0].status).toBe("available");

      const bookingSeatsRes = await pool.query("SELECT seat_id FROM booking_seats WHERE seat_id = $1", [
        seatIdsByLabel.A2,
      ]);
      expect(bookingSeatsRes.rows).toHaveLength(0);
    });

    it("404s for a request naming one unknown seat and one already-booked seat — 404 takes precedence over 409", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();

      await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
      });

      const res = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: {
          seat_ids: [seatIdsByLabel.A1, "00000000-0000-0000-0000-000000000000"],
          user_id: "user-2",
          idempotency_key: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(404);
    });
  });
}

// Every mechanism's central claim: under real concurrency at one seat,
// exactly one request wins. Separate from runBookingContractTests since it's
// the one test whose point is exercising genuine contention, not just HTTP
// behavior for a single request at a time.
//
// `loserStatus` defaults to 409 (an ordinary conflict) but a mechanism whose
// retry budget is forced to 0 (optimistic, serializable — ADR-0012) exhausts
// on the very first attempt instead. `acceptableLoserStatuses` overrides
// `loserStatus` for a mechanism whose losers can genuinely split across more
// than one status under real (non-zero-cap) contention — serializable's
// losers resolve via either an ordinary re-read (409) or, on the rarer
// timing where their own read raced the winner's commit, a genuine
// SERIALIZABLE conflict that exhausts its retry budget (503); which one
// happens for a given loser isn't controllable from outside (confirmed
// empirically), so the two must be accepted together rather than asserting
// an exact count for either.
//
// `checkZeroRetries` defaults to true: every losing response is a clean,
// single-attempt outcome for every mechanism except serializable under a
// real (non-zero-cap) race, where a loser can only discover it lost by
// retrying the whole transaction and re-reading — unlike optimistic's cheap
// re-read-before-retrying, there's no way to learn "someone else won"
// without spending a retry, so its ordinary losers legitimately report a
// nonzero count. Callers for whom that's expected pass `false`.
export function runBookingConcurrencyContractTest(
  strategyLabel: string,
  createApp: () => FastifyInstance,
  options: { loserStatus?: number; acceptableLoserStatuses?: number[]; checkZeroRetries?: boolean } = {},
): void {
  const loserStatus = options.loserStatus ?? 409;
  const acceptableLoserStatuses = options.acceptableLoserStatuses ?? [loserStatus];
  const checkZeroRetries = options.checkZeroRetries ?? true;

  describe(`POST /bookings (${strategyLabel} strategy) — concurrency`, () => {
    beforeEach(resetDb);

    it(`under concurrent requests for one seat, exactly one 201 and the rest ${acceptableLoserStatuses.join("/")} — never 500`, async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const concurrency = 25;

      const responses = await Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/bookings",
            payload: { seat_ids: [seatIdsByLabel.A1], user_id: `user-${i}`, idempotency_key: `race-${i}` },
          }),
        ),
      );

      const statusCounts = responses.reduce<Record<number, number>>((counts, res) => {
        counts[res.statusCode] = (counts[res.statusCode] ?? 0) + 1;
        return counts;
      }, {});

      const loserCount = acceptableLoserStatuses.reduce((sum, status) => sum + (statusCounts[status] ?? 0), 0);

      expect(statusCounts[201]).toBe(1);
      expect(loserCount).toBe(concurrency - 1);
      expect(statusCounts[500]).toBeUndefined();

      if (checkZeroRetries) {
        for (const res of responses) {
          expect(res.headers["x-booking-retries"]).toBe("0");
        }
      }

      const bookingSeatsRes = await pool.query(
        "SELECT booking_id FROM booking_seats WHERE seat_id = $1",
        [seatIdsByLabel.A1],
      );
      expect(bookingSeatsRes.rows).toHaveLength(1);
    });
  });
}
