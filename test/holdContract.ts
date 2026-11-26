import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { runReaperSweep } from "../src/reaper.js";
import { createHold, expireHold, interceptQuery, resetDb, seedEventWithSeats } from "./testDb.js";

// Shared behavioural contract for hold creation, mirroring bookingContract.ts's
// runBookingContractTests shape and seam (HTTP in, HTTP + DB state out) —
// except this is called from exactly one strategy file (pessimistic.test.ts's
// hold suite), since the hold flow is implemented for `pessimistic` only
// (ADR-0017), not parameterized across all six mechanisms the way booking's
// contract tests are.
export function runHoldContractTests(strategyLabel: string, createApp: () => FastifyInstance): void {
  describe(`POST /holds (${strategyLabel} strategy)`, () => {
    beforeEach(resetDb);

    it("holds an available seat", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();

      const res = await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
      });
      const body = res.json() as { id: string; seat_ids: string[]; held_until: string };

      expect(res.statusCode).toBe(201);
      expect(body.id).toBeTypeOf("string");
      expect(body.seat_ids).toEqual([seatIdsByLabel.A1]);
      expect(new Date(body.held_until).getTime()).toBeGreaterThan(Date.now());

      const seatRes = await pool.query("SELECT status, booked_by, held_until, version FROM seats WHERE id = $1", [
        seatIdsByLabel.A1,
      ]);
      expect(seatRes.rows[0]).toMatchObject({ status: "held", booked_by: "user-1", version: 1 });
      expect(seatRes.rows[0].held_until).not.toBeNull();

      const holdSeatsRes = await pool.query("SELECT hold_id FROM hold_seats WHERE seat_id = $1", [
        seatIdsByLabel.A1,
      ]);
      expect(holdSeatsRes.rows).toHaveLength(1);
      expect(holdSeatsRes.rows[0].hold_id).toBe(body.id);
    });

    it("409s when the seat is already held", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();

      await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
      });

      const res = await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-2", idempotency_key: randomUUID() },
      });

      expect(res.statusCode).toBe(409);
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
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-2", idempotency_key: randomUUID() },
      });

      expect(res.statusCode).toBe(409);
    });

    it("404s for an unknown seat", async () => {
      const app = createApp();
      const res = await app.inject({
        method: "POST",
        url: "/holds",
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
      const res = await app.inject({ method: "POST", url: "/holds", payload: { user_id: "user-1" } });
      expect(res.statusCode).toBe(400);
    });

    it("400s when seat_ids contains a duplicate", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();

      const res = await app.inject({
        method: "POST",
        url: "/holds",
        payload: {
          seat_ids: [seatIdsByLabel.A1, seatIdsByLabel.A1],
          user_id: "user-1",
          idempotency_key: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns the same hold id and 201 when the identical request is sent twice", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const payload = { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() };

      const first = await app.inject({ method: "POST", url: "/holds", payload });
      const second = await app.inject({ method: "POST", url: "/holds", payload });

      const firstBody = first.json() as { id: string };
      const secondBody = second.json() as { id: string };

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(secondBody.id).toBe(firstBody.id);

      const holdSeatsRes = await pool.query("SELECT hold_id FROM hold_seats WHERE seat_id = $1", [
        seatIdsByLabel.A1,
      ]);
      expect(holdSeatsRes.rows).toHaveLength(1);
    });

    it("replays the same hold for a duplicate idempotency_key instead of creating a second one", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
      const app = createApp();
      const idempotencyKey = randomUUID();

      const first = await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: idempotencyKey },
      });
      const firstBody = first.json() as { id: string; seat_ids: string[] };

      // Same idempotency_key, different seat: must not create a second hold,
      // and must echo the original hold's seats, not this request's.
      const second = await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A2], user_id: "user-1", idempotency_key: idempotencyKey },
      });
      const secondBody = second.json() as { id: string; seat_ids: string[] };

      expect(second.statusCode).toBe(201);
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.seat_ids).toEqual(firstBody.seat_ids);

      const countRes = await pool.query("SELECT count(*)::int AS count FROM holds");
      expect(countRes.rows[0].count).toBe(1);

      const seatA2 = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A2]);
      expect(seatA2.rows[0].status).toBe("available");
    });
  });
}

// Multi-seat hold contract (mirrors runMultiSeatBookingContractTests):
// all-or-nothing acquisition across the requested set.
export function runMultiSeatHoldContractTests(strategyLabel: string, createApp: () => FastifyInstance): void {
  describe(`POST /holds (${strategyLabel} strategy) — multi-seat`, () => {
    beforeEach(resetDb);

    it("holds multiple available seats in one request", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
      const app = createApp();

      const res = await app.inject({
        method: "POST",
        url: "/holds",
        payload: {
          seat_ids: [seatIdsByLabel.A1, seatIdsByLabel.A2],
          user_id: "user-1",
          idempotency_key: randomUUID(),
        },
      });
      const body = res.json() as { id: string; seat_ids: string[]; held_until: string };

      expect(res.statusCode).toBe(201);
      expect(new Set(body.seat_ids)).toEqual(new Set([seatIdsByLabel.A1, seatIdsByLabel.A2]));

      const seatRes = await pool.query("SELECT status, held_until FROM seats WHERE id = ANY($1)", [
        [seatIdsByLabel.A1, seatIdsByLabel.A2],
      ]);
      expect(seatRes.rows.every((row) => row.status === "held")).toBe(true);
      // Both seats were acquired in one transaction, so they share the exact
      // same held_until (now() is stable per-transaction).
      expect(seatRes.rows[0].held_until).toEqual(seatRes.rows[1].held_until);

      const holdSeatsRes = await pool.query("SELECT seat_id FROM hold_seats WHERE hold_id = $1", [body.id]);
      expect(holdSeatsRes.rows).toHaveLength(2);
    });

    it("is all-or-nothing: one seat already held fails the whole request, leaving the other seat untouched", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
      const app = createApp();

      await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
      });

      const res = await app.inject({
        method: "POST",
        url: "/holds",
        payload: {
          seat_ids: [seatIdsByLabel.A2, seatIdsByLabel.A1],
          user_id: "user-2",
          idempotency_key: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(409);

      const seatA2 = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A2]);
      expect(seatA2.rows[0].status).toBe("available");

      const holdSeatsRes = await pool.query("SELECT seat_id FROM hold_seats WHERE seat_id = $1", [
        seatIdsByLabel.A2,
      ]);
      expect(holdSeatsRes.rows).toHaveLength(0);
    });

    it("404s for a request naming one unknown seat and one already-held seat — 404 takes precedence over 409", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();

      await app.inject({
        method: "POST",
        url: "/holds",
        payload: { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() },
      });

      const res = await app.inject({
        method: "POST",
        url: "/holds",
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

// Shared behavioural contract for hold confirmation (issue #39), mirroring
// runHoldContractTests' seam/calling convention: HTTP in, HTTP + DB state
// out, called from exactly one strategy file since confirm is pessimistic-
// only (ADR-0017). The 409 (lost the row lock to a genuinely concurrent
// confirm) case lives in pessimisticHold.test.ts instead, alongside that
// file's own NOWAIT-conflict tests, since it needs withHeldRowLock (a
// pessimistic-specific technique) rather than anything shared here.
export function runHoldConfirmContractTests(strategyLabel: string, createApp: () => FastifyInstance): void {
  describe(`POST /holds/:id/confirm (${strategyLabel} strategy)`, () => {
    beforeEach(resetDb);

    it("confirms a live hold into a booking", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const hold = await createHold(app, [seatIdsByLabel.A1!], "user-1");

      const res = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });
      const body = res.json() as { id: string; created_at: string };

      expect(res.statusCode).toBe(201);
      expect(body.id).toBeTypeOf("string");
      expect(res.headers["x-booking-retries"]).toBe("0");

      const seatRes = await pool.query("SELECT status, booked_by, held_until, version FROM seats WHERE id = $1", [
        seatIdsByLabel.A1,
      ]);
      expect(seatRes.rows[0]).toMatchObject({ status: "booked", booked_by: "user-1", held_until: null, version: 2 });

      const bookingSeatsRes = await pool.query("SELECT booking_id FROM booking_seats WHERE seat_id = $1", [
        seatIdsByLabel.A1,
      ]);
      expect(bookingSeatsRes.rows).toHaveLength(1);
      expect(bookingSeatsRes.rows[0].booking_id).toBe(body.id);

      const holdSeatsRes = await pool.query("SELECT 1 FROM hold_seats WHERE hold_id = $1", [hold.id]);
      expect(holdSeatsRes.rows).toHaveLength(0);
      const holdsRes = await pool.query("SELECT 1 FROM holds WHERE id = $1", [hold.id]);
      expect(holdsRes.rows).toHaveLength(0);
    });

    it("confirms every seat in a multi-seat hold atomically", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
      const app = createApp();
      const hold = await createHold(app, [seatIdsByLabel.A1!, seatIdsByLabel.A2!]);

      const res = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });
      const body = res.json() as { id: string };

      expect(res.statusCode).toBe(201);

      const seatRes = await pool.query("SELECT status FROM seats WHERE id = ANY($1)", [
        [seatIdsByLabel.A1, seatIdsByLabel.A2],
      ]);
      expect(seatRes.rows.every((row) => row.status === "booked")).toBe(true);

      const bookingSeatsRes = await pool.query("SELECT seat_id FROM booking_seats WHERE booking_id = $1", [
        body.id,
      ]);
      expect(bookingSeatsRes.rows).toHaveLength(2);
    });

    it("has no ownership check — any caller with a valid hold id can confirm it", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const hold = await createHold(app, [seatIdsByLabel.A1!], "owner");

      // No user_id / auth sent with the confirm at all — it's bodyless.
      const res = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });
      expect(res.statusCode).toBe(201);

      const seatRes = await pool.query("SELECT booked_by FROM seats WHERE id = $1", [seatIdsByLabel.A1]);
      expect(seatRes.rows[0].booked_by).toBe("owner");
    });

    it("410s when the hold has already expired", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const hold = await createHold(app, [seatIdsByLabel.A1!]);

      // Seeded directly, not via a real wait — this doesn't require the
      // reaper to exist, since confirm's own lazy check is what enforces
      // expiry (ADR-0018).
      await expireHold([seatIdsByLabel.A1!]);

      const res = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });
      expect(res.statusCode).toBe(410);

      const seatRes = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A1]);
      expect(seatRes.rows[0].status).toBe("held");
    });

    it("404s for an unknown hold id", async () => {
      const app = createApp();
      const res = await app.inject({
        method: "POST",
        url: "/holds/00000000-0000-0000-0000-000000000000/confirm",
      });
      expect(res.statusCode).toBe(404);
    });

    it("404s (not 500) for a malformed hold id", async () => {
      const app = createApp();
      const res = await app.inject({ method: "POST", url: "/holds/not-a-uuid/confirm" });
      expect(res.statusCode).toBe(404);
    });

    it("replays the same booking, not a duplicate, when confirm is retried on an already-confirmed hold", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const hold = await createHold(app, [seatIdsByLabel.A1!]);

      const first = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });
      const second = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });

      const firstBody = first.json() as { id: string };
      const secondBody = second.json() as { id: string };

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(secondBody.id).toBe(firstBody.id);

      const countRes = await pool.query("SELECT count(*)::int AS count FROM bookings");
      expect(countRes.rows[0].count).toBe(1);
    });

    it("confirms its own hold correctly even if a direct booking was made with idempotency_key equal to this hold's raw id", async () => {
      // Regression test (caught in code review): confirm synthesizes
      // bookings.idempotency_key from the hold's own id. If that synthesized
      // key weren't namespaced, a client-supplied idempotency_key on a
      // direct POST /bookings equal to some other hold's raw id would
      // collide with it — this proves confirm still finds/creates its own
      // booking rather than replaying the unrelated one.
      const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
      const app = createApp();
      const hold = await createHold(app, [seatIdsByLabel.A1!], "holder");

      const collidingBooking = await app.inject({
        method: "POST",
        url: "/bookings",
        payload: { seat_ids: [seatIdsByLabel.A2], user_id: "other-user", idempotency_key: hold.id },
      });
      expect(collidingBooking.statusCode).toBe(201);
      const collidingBody = collidingBooking.json() as { id: string };

      const res = await app.inject({ method: "POST", url: `/holds/${hold.id}/confirm` });
      const body = res.json() as { id: string };

      expect(res.statusCode).toBe(201);
      expect(body.id).not.toBe(collidingBody.id);

      const seatA1 = await pool.query("SELECT status, booked_by FROM seats WHERE id = $1", [seatIdsByLabel.A1]);
      expect(seatA1.rows[0]).toMatchObject({ status: "booked", booked_by: "holder" });
    });
  });
}

// Every mechanism's central claim, applied to holds: under real concurrency
// at one seat, exactly one hold request wins. Mirrors
// runBookingConcurrencyContractTest's shape.
export function runHoldConcurrencyContractTest(strategyLabel: string, createApp: () => FastifyInstance): void {
  describe(`POST /holds (${strategyLabel} strategy) — concurrency`, () => {
    beforeEach(resetDb);

    it("under concurrent requests for one seat, exactly one 201 and the rest 409 — never 500", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const concurrency = 25;

      const responses = await Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/holds",
            payload: { seat_ids: [seatIdsByLabel.A1], user_id: `user-${i}`, idempotency_key: `race-${i}` },
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

      const holdSeatsRes = await pool.query("SELECT hold_id FROM hold_seats WHERE seat_id = $1", [
        seatIdsByLabel.A1,
      ]);
      expect(holdSeatsRes.rows).toHaveLength(1);
    });
  });
}

// RF1 (ADR-0030): a Hold's Idempotency Key outlives the hold. Hold -> expire
// -> reap, or hold -> confirm, then retry POST /holds with the same key: no
// second Hold is created and the answer is 410 key_released (reason
// "expired" / "confirmed"), not a replay of a hold that no longer exists.
export function runHoldKeyReleaseContractTests(strategyLabel: string, createApp: () => FastifyInstance): void {
  describe(`POST /holds (${strategyLabel} strategy) — idempotency key after the hold is gone (RF1)`, () => {
    beforeEach(resetDb);

    it("answers 410 (expired) and creates no second hold when an expired, reaped hold's key is retried", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const payload = { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() };
      const first = await app.inject({ method: "POST", url: "/holds", payload });
      expect(first.statusCode).toBe(201);
      const { id: holdId } = first.json() as { id: string };
      await expireHold([seatIdsByLabel.A1!]);
      await runReaperSweep(pool);

      const retry = await app.inject({ method: "POST", url: "/holds", payload });

      expect(retry.statusCode).toBe(410);
      expect(retry.json()).toMatchObject({ outcome: "key_released", reason: "expired", released_id: holdId });
      const holdsRes = await pool.query("SELECT 1 FROM holds WHERE idempotency_key = $1", [payload.idempotency_key]);
      expect(holdsRes.rows).toHaveLength(0);
      const seatRes = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A1]);
      expect(seatRes.rows[0]).toMatchObject({ status: "available" });
    });

    it("answers 410 (confirmed) when a confirmed hold's key is retried, and leaves the Booking alone", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const payload = { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() };
      const { id: holdId } = (await app.inject({ method: "POST", url: "/holds", payload })).json() as { id: string };
      expect((await app.inject({ method: "POST", url: `/holds/${holdId}/confirm` })).statusCode).toBe(201);

      const retry = await app.inject({ method: "POST", url: "/holds", payload });

      expect(retry.statusCode).toBe(410);
      expect(retry.json()).toMatchObject({ outcome: "key_released", reason: "confirmed", released_id: holdId });
      const seatRes = await pool.query("SELECT status FROM seats WHERE id = $1", [seatIdsByLabel.A1]);
      expect(seatRes.rows[0]).toMatchObject({ status: "booked" });
      const bookingsRes = await pool.query("SELECT 1 FROM bookings");
      expect(bookingsRes.rows).toHaveLength(1);
    });
  });
}

// RF2 (issue #61, ADR-0031), the Hold half of runIdempotencyKeyRaceContractTests
// (bookingContract.ts): a same-key POST /holds retry that races the original's
// commit replays it instead of being told 409. Same staging: the original
// (a real POST /holds through the same app) commits right after the retry's own
// key lookup returned empty.
export function runHoldKeyRaceContractTests(
  strategyLabel: string,
  createApp: () => FastifyInstance,
  withHeldSeat: <T>(lockSeatId: string, fn: () => Promise<T>) => Promise<T>,
): void {
  describe(`POST /holds (${strategyLabel} strategy) — same-key retry racing the original (RF2)`, () => {
    beforeEach(resetDb);

    async function retryWhileOriginalCommitsAfterLookup(app: FastifyInstance, originalPayload: object, retryPayload: object) {
      let original: Awaited<ReturnType<FastifyInstance["inject"]>> | undefined;
      const intercept = interceptQuery(
        "SELECT 'live'",
        async () => {
          original = await app.inject({ method: "POST", url: "/holds", payload: originalPayload });
        },
        (result) => (result as { rows: unknown[] }).rows.length === 0,
      );
      let retry;
      try {
        retry = await app.inject({ method: "POST", url: "/holds", payload: retryPayload });
      } finally {
        intercept.restore();
      }
      expect(intercept.wasTriggered()).toBe(true);
      return { original: original!, retry };
    }

    it("replays the original Hold when it commits between the retry's key lookup and its lock", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const payload = { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() };

      const { original, retry } = await retryWhileOriginalCommitsAfterLookup(app, payload, payload);

      expect(original.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toMatchObject({
        id: (original.json() as { id: string }).id,
        seat_ids: [seatIdsByLabel.A1],
      });
      expect((await pool.query("SELECT 1 FROM holds")).rows).toHaveLength(1);
    });

    it("still answers 409 when the winner of the same seat carries a DIFFERENT key", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const winner = { seat_ids: [seatIdsByLabel.A1], user_id: "user-2", idempotency_key: randomUUID() };
      const loser = { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() };

      const { original, retry } = await retryWhileOriginalCommitsAfterLookup(app, winner, loser);

      expect(original.statusCode).toBe(201);
      expect(retry.statusCode).toBe(409);
      expect((await pool.query("SELECT idempotency_key FROM holds")).rows).toEqual([{ idempotency_key: winner.idempotency_key }]);
    });

    it("still answers 409 with no replay while the original is in flight (its seat lock held, nothing committed)", async () => {
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const app = createApp();
      const payload = { seat_ids: [seatIdsByLabel.A1], user_id: "user-1", idempotency_key: randomUUID() };

      const retry = await withHeldSeat(seatIdsByLabel.A1!, () => app.inject({ method: "POST", url: "/holds", payload }));

      expect(retry.statusCode).toBe(409);
      expect((await pool.query("SELECT 1 FROM holds")).rows).toHaveLength(0);
    });

    it("replays a COMMITTED original even while a concurrent Confirm of that very Hold holds the seat's lock", async () => {
      // The lock-failure half: the Hold exists (key committed), and an in-flight Confirm
      // (or any transaction) holds its seats' row locks, so the retry's NOWAIT fails. The
      // retry's lookup is made to miss by keeping the original uncommitted until after it.
      const { seatIdsByLabel } = await seedEventWithSeats(["A1"]);
      const seatId = seatIdsByLabel.A1!;
      const app = createApp();
      const key = randomUUID();

      const original = await pool.connect();
      await original.query("BEGIN");
      const { rows } = await original.query<{ id: string }>("INSERT INTO holds (idempotency_key) VALUES ($1) RETURNING id", [key]);
      const holdId = rows[0]!.id;
      await original.query("INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)", [holdId, seatId]);
      await original.query(
        "UPDATE seats SET status = 'held', booked_by = 'user-1', held_until = now() + interval '5 minutes', version = version + 1 WHERE id = $1",
        [seatId],
      );

      let retryAnswered!: () => void;
      const retryDone = new Promise<void>((resolve) => (retryAnswered = resolve));
      let holder: Promise<unknown> | undefined;
      const intercept = interceptQuery(
        "SELECT 'live'",
        async () => {
          await original.query("COMMIT");
          original.release();
          await new Promise<void>((held) => {
            holder = withHeldSeat(seatId, async () => {
              held();
              await retryDone;
            });
          });
        },
        (result) => (result as { rows: unknown[] }).rows.length === 0,
      );
      let retry;
      try {
        retry = await app.inject({
          method: "POST",
          url: "/holds",
          payload: { seat_ids: [seatId], user_id: "user-1", idempotency_key: key },
        });
      } finally {
        intercept.restore();
        retryAnswered();
        await holder;
      }

      expect(intercept.wasTriggered()).toBe(true);
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toMatchObject({ id: holdId });
    });
  });
}
