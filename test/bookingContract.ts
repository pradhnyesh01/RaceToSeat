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
      // Every mechanism carries this header (ADR-0012); pessimistic and
      // advisory never retry, so it must always read "0" for them. naive and
      // unique_constraint can retry too now (issue #26/#27's
      // withDeadlockRetry, for a multi-seat deadlock abort) but never for
      // this single-seat request — that class of deadlock needs at least two
      // seats to form a cycle.
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

// Shared assertion shell for issue #34's cross-seat isolation proof: seed two
// seats, hold a claim on one via the caller-supplied, mechanism-specific
// `withHeldSeatA` (naive's open UPDATE, unique_constraint's open
// booking_seats INSERT, optimistic's open CAS, serializable's open
// SERIALIZABLE transaction, pessimistic's FOR UPDATE NOWAIT hold, advisory's
// pg_advisory_xact_lock hold), and assert a concurrent request for the other
// seat still resolves quickly. Only the hold technique is mechanism-specific
// (the acceptance criterion this ticket cares about); the timing/assertion
// shape itself is identical across all six mechanisms, so it lives here once
// rather than being copy-pasted per strategy file.
export function runCrossSeatIsolationContractTest(
  strategyLabel: string,
  createApp: () => FastifyInstance,
  withHeldSeatA: <T>(lockSeatId: string, fn: () => Promise<T>) => Promise<T>,
): void {
  describe(`POST /bookings (${strategyLabel} strategy) — cross-seat isolation`, () => {
    beforeEach(resetDb);

    it("a request for an unrelated seat resolves quickly while another seat's claim is held open", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "B1"]);
      const heldSeatId = seatIdsByLabel.A1!;
      const otherSeatId = seatIdsByLabel.B1!;
      const app = createApp();

      // Generous relative to a real block (which would run into the held
      // claim's own release well before this) — this confirms "fast", not a
      // tight latency budget.
      let elapsedMs = 0;
      const res = await withHeldSeatA(heldSeatId, async () => {
        const start = Date.now();
        const response = await app.inject({
          method: "POST",
          url: "/bookings",
          payload: { seat_ids: [otherSeatId], user_id: "user-1", idempotency_key: randomUUID() },
        });
        elapsedMs = Date.now() - start;
        return response;
      });

      expect(res.statusCode).toBe(201);
      expect(elapsedMs).toBeLessThan(2000);
    });
  });
}

// RF1 (ADR-0030): an Idempotency Key outlives its Booking. Book -> cancel ->
// retry with the SAME key must not create a second Booking (the retry is a
// stale duplicate of an attempt that already happened and was undone); it is
// answered 410 key_released instead of a replay of an id that no longer
// exists, and a fresh key for the same seat still books normally. The key
// lookup lives in every mechanism's own code path (and in its race fallback),
// so this runs once per mechanism rather than once overall.
export function runIdempotencyKeyReleaseContractTest(
  strategyLabel: string,
  createApp: () => FastifyInstance,
): void {
  describe(`POST /bookings (${strategyLabel} strategy) — idempotency key after cancel (RF1)`, () => {
    beforeEach(resetDb);

    it("answers 410 and creates nothing when a cancelled booking's key is retried", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const payload = { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() };

      const first = await app.inject({ method: "POST", url: "/bookings", payload });
      expect(first.statusCode).toBe(201);
      const { id: bookingId } = first.json() as { id: string };
      expect((await app.inject({ method: "DELETE", url: `/bookings/${bookingId}` })).statusCode).toBe(204);

      const retry = await app.inject({ method: "POST", url: "/bookings", payload });

      expect(retry.statusCode).toBe(410);
      expect(retry.json()).toMatchObject({ outcome: "key_released", reason: "cancelled", released_id: bookingId });

      const bookingsRes = await pool.query("SELECT 1 FROM bookings WHERE idempotency_key = $1", [payload.idempotency_key]);
      expect(bookingsRes.rows).toHaveLength(0);
      const seatRes = await pool.query("SELECT status, booked_by FROM seats WHERE id = $1", [seatIdsByLabel.A1]);
      expect(seatRes.rows[0]).toMatchObject({ status: "available", booked_by: null });
    });

    it("still books the freed seat under a fresh key after the stale retry was refused", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const stale = { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() };
      const { id } = (await app.inject({ method: "POST", url: "/bookings", payload: stale })).json() as { id: string };
      await app.inject({ method: "DELETE", url: `/bookings/${id}` });
      await app.inject({ method: "POST", url: "/bookings", payload: stale });

      const fresh = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { ...stale, idempotency_key: randomUUID() },
      });

      expect(fresh.statusCode).toBe(201);
    });

    it("refuses the stale key even for a different seat set, and answers it before looking at seats", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "B1"]);
      const app = createApp();
      const key = randomUUID();
      const { id } = (
        await app.inject({
          method: "POST",
          url: "/bookings",
          payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: key },
        })
      ).json() as { id: string };
      await app.inject({ method: "DELETE", url: `/bookings/${id}` });

      const retry = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_ids: [seatIdsByLabel.B1], user_id: "user-2", idempotency_key: key },
      });

      expect(retry.statusCode).toBe(410);
      const seatRes = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.B1]);
      expect(seatRes.rows[0]).toMatchObject({ status: "available" });
    });
  });
}
