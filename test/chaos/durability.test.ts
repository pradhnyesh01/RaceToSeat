// Negative controls for Oracle 5, durability of acknowledged work (issue #51,
// C4, ADR-0032/0023): the Oracle is run against states corrupted by hand in
// exactly the way a lost commit corrupts them, and must flag each; every test
// has a clean twin. The end-to-end control (an unsafe Postgres, SIGKILLed under
// load) is recorded in Exhibit H; these pin the checker's own logic, including
// the one property that justifies a fifth Oracle at all: a lost commit leaves a
// state the other four Oracles accept.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAcknowledgedDurability, type AcknowledgedBooking, type AcknowledgedHold } from "../../load-harness/chaos/durabilityOracle.js";
import { runOracles, snapshotBookingsByKey } from "../../load-harness/chaos/oracles.js";
import { createScratchDb, IDEMPOTENCY_UNIQUE_CONSTRAINTS, type ScratchDb } from "../../load-harness/chaos/scratchDb.js";
import { confirmIdempotencyKey } from "../../src/strategies/pessimisticConfirm.js";

let scratch: ScratchDb;
let db: Pool;

beforeAll(async () => {
  // Idempotency uniqueness dropped only so the "two bookings for one key" control can exist.
  scratch = await createScratchDb(process.env.DATABASE_URL!, IDEMPOTENCY_UNIQUE_CONSTRAINTS);
  db = scratch.pool;
});

afterAll(async () => {
  await scratch?.drop();
});

async function seedEvent(seatCount: number): Promise<{ eventId: string; seatIds: string[] }> {
  const eventId = (await db.query<{ id: string }>("INSERT INTO events (name) VALUES ('durability test') RETURNING id")).rows[0]!.id;
  const seats = await db.query<{ id: string }>(
    "INSERT INTO seats (event_id, label) SELECT $1, 'S' || gs FROM generate_series(1, $2) gs RETURNING id",
    [eventId, seatCount],
  );
  return { eventId, seatIds: seats.rows.map((row) => row.id) };
}

const key = () => `key-${randomUUID()}`;

// A Booking the way a real mechanism leaves it, plus the client's record of the 201.
async function committedBooking(seatIds: string[], userId = "user-1"): Promise<AcknowledgedBooking> {
  const idempotencyKey = key();
  const bookingId = (await db.query<{ id: string }>("INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id", [userId, idempotencyKey])).rows[0]!.id;
  for (const seatId of seatIds) await db.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [bookingId, seatId]);
  await db.query("UPDATE seats SET status = 'booked', booked_by = $1 WHERE id = ANY($2)", [userId, seatIds]);
  return { idempotencyKey, userId, seatIds, bookingId };
}

// What a crash that forgot the commit leaves behind: nothing at all.
async function loseCommit(a: AcknowledgedBooking): Promise<void> {
  await db.query("DELETE FROM booking_seats WHERE booking_id = $1", [a.bookingId]);
  await db.query("DELETE FROM bookings WHERE id = $1", [a.bookingId]);
  await db.query("UPDATE seats SET status = 'available', booked_by = NULL WHERE id = ANY($1)", [a.seatIds]);
}

const kinds = (r: { violations: { kind: string }[] }) => r.violations.map((v) => v.kind);

describe("Oracle 5: acknowledged Bookings", () => {
  it("passes when every acknowledged Booking is present (clean twin)", async () => {
    const { eventId, seatIds } = await seedEvent(3);
    const acked = [await committedBooking([seatIds[0]!]), await committedBooking([seatIds[1]!, seatIds[2]!])];
    const result = await checkAcknowledgedDurability(db, { eventId }, { bookings: acked });
    expect(result.violations).toEqual([]);
    expect(result.oracle).toBe(5);
  });

  it("flags an acknowledged Booking that is gone", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const kept = await committedBooking([seatIds[0]!]);
    const lost = await committedBooking([seatIds[1]!]);
    await loseCommit(lost);
    const result = await checkAcknowledgedDurability(db, { eventId }, { bookings: [kept, lost] });
    expect(kinds(result)).toEqual(["acknowledged-booking-lost"]);
    expect(result.violations[0]!.bookingIds).toEqual([lost.bookingId]);
  });

  it("flags a lost commit even when something re-created the key's Booking under a new id (the replay's effect)", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const lost = await committedBooking([seatIds[0]!]);
    await loseCommit(lost);
    const reborn = await db.query<{ id: string }>("INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id", [lost.userId, lost.idempotencyKey]);
    await db.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [reborn.rows[0]!.id, seatIds[0]]);
    await db.query("UPDATE seats SET status = 'booked', booked_by = $1 WHERE id = $2", [lost.userId, seatIds[0]]);
    expect(kinds(await checkAcknowledgedDurability(db, { eventId }, { bookings: [lost] }))).toEqual(["acknowledged-booking-lost"]);
  });

  it("flags an acknowledged multi-seat Booking that lost one of its seats", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const acked = await committedBooking([seatIds[0]!, seatIds[1]!]);
    await db.query("DELETE FROM booking_seats WHERE booking_id = $1 AND seat_id = $2", [acked.bookingId, seatIds[1]]);
    expect(kinds(await checkAcknowledgedDurability(db, { eventId }, { bookings: [acked] }))).toContain("acknowledged-booking-seats-changed");
  });

  it("flags a Booking whose seat was rolled back to 'available'", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const acked = await committedBooking([seatIds[0]!]);
    await db.query("UPDATE seats SET status = 'available', booked_by = NULL WHERE id = $1", [seatIds[0]]);
    expect(kinds(await checkAcknowledgedDurability(db, { eventId }, { bookings: [acked] }))).toContain("acknowledged-seat-not-booked");
  });

  it("flags a Booking stored under a different key than it was acknowledged for", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const acked = await committedBooking([seatIds[0]!]);
    await db.query("UPDATE bookings SET idempotency_key = $1 WHERE id = $2", [key(), acked.bookingId]);
    expect(kinds(await checkAcknowledgedDurability(db, { eventId }, { bookings: [acked] }))).toContain("acknowledged-booking-wrong-key");
  });

  it("flags a second Booking under an acknowledged key", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const acked = await committedBooking([seatIds[0]!]);
    const second = await db.query<{ id: string }>("INSERT INTO bookings (user_id, idempotency_key) VALUES ('user-2', $1) RETURNING id", [acked.idempotencyKey]);
    await db.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [second.rows[0]!.id, seatIds[1]]);
    expect(kinds(await checkAcknowledgedDurability(db, { eventId }, { bookings: [acked] }))).toContain("acknowledged-key-has-multiple-bookings");
  });

  it("does not flag state that nobody was told about (an unacknowledged commit is not this Oracle's business)", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await committedBooking([seatIds[0]!]);
    expect((await checkAcknowledgedDurability(db, { eventId }, { bookings: [] })).passed).toBe(true);
  });

  it("is the only Oracle that sees a lost commit: Oracles 1-4 all pass on the state it leaves", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const kept = await committedBooking([seatIds[0]!]);
    const lost = await committedBooking([seatIds[1]!]);
    await loseCommit(lost);
    const ledger = [kept, lost].map((a) => ({ idempotencyKey: a.idempotencyKey, seatIds: a.seatIds }));
    const before = await snapshotBookingsByKey(db, ledger.map((l) => l.idempotencyKey));
    const four = await runOracles(db, { scope: { eventId }, ledger, before });
    expect(four.map((o) => o.passed)).toEqual([true, true, true, true]);
    expect((await checkAcknowledgedDurability(db, { eventId }, { bookings: [kept, lost] })).passed).toBe(false);
  });
});

async function liveHold(seatIds: string[], ttl = "5 minutes"): Promise<AcknowledgedHold> {
  const holdId = (await db.query<{ id: string }>("INSERT INTO holds (idempotency_key) VALUES ($1) RETURNING id", [key()])).rows[0]!.id;
  for (const seatId of seatIds) await db.query("INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)", [holdId, seatId]);
  const until = (await db.query<{ t: string }>(`UPDATE seats SET status = 'held', held_until = now() + interval '${ttl}' WHERE id = ANY($1) RETURNING held_until::text AS t`, [seatIds])).rows[0]!.t;
  return { holdId, seatIds, userId: "user-1", heldUntil: until };
}

async function dropHold(h: AcknowledgedHold): Promise<void> {
  await db.query("DELETE FROM hold_seats WHERE hold_id = $1", [h.holdId]);
  await db.query("DELETE FROM holds WHERE id = $1", [h.holdId]);
  await db.query("UPDATE seats SET status = 'available', held_until = NULL WHERE id = ANY($1)", [h.seatIds]);
}

describe("Oracle 5: acknowledged Holds and Confirms", () => {
  it("passes for a live Hold (clean twin)", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    expect((await checkAcknowledgedDurability(db, { eventId }, { holds: [await liveHold([seatIds[0]!])] })).passed).toBe(true);
  });

  it("flags an acknowledged, unexpired Hold that is gone", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const h = await liveHold([seatIds[0]!]);
    await dropHold(h);
    expect(kinds(await checkAcknowledgedDurability(db, { eventId }, { holds: [h] }))).toEqual(["acknowledged-hold-lost"]);
  });

  it("accepts a Hold that is gone because it expired (reaped), flags the same one if it had not", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const expired = await liveHold([seatIds[0]!], "-1 seconds");
    await dropHold(expired);
    expect((await checkAcknowledgedDurability(db, { eventId }, { holds: [expired] })).passed).toBe(true);
    const unexpired = await liveHold([seatIds[1]!]);
    await dropHold(unexpired);
    expect((await checkAcknowledgedDurability(db, { eventId }, { holds: [unexpired] })).passed).toBe(false);
  });

  it("accepts a Hold that became a Booking even if the client never saw its Confirm answered", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const h = await liveHold([seatIds[0]!]);
    await dropHold(h);
    await db.query("INSERT INTO bookings (user_id, idempotency_key) VALUES ('user-1', $1)", [confirmIdempotencyKey(h.holdId)]);
    expect((await checkAcknowledgedDurability(db, { eventId }, { holds: [h] })).passed).toBe(true);
  });

  it("flags an acknowledged Confirm whose Booking is gone", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const h = await liveHold([seatIds[0]!]);
    await dropHold(h);
    const bookingId = randomUUID();
    expect(kinds(await checkAcknowledgedDurability(db, { eventId }, { holds: [{ ...h, confirmedBookingId: bookingId }] }))).toEqual(["acknowledged-confirm-lost"]);
  });

  it("passes an acknowledged Confirm whose Booking is present", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const h = await liveHold([seatIds[0]!]);
    await dropHold(h);
    const bookingId = (await db.query<{ id: string }>("INSERT INTO bookings (user_id, idempotency_key) VALUES ('user-1', $1) RETURNING id", [confirmIdempotencyKey(h.holdId)])).rows[0]!.id;
    expect((await checkAcknowledgedDurability(db, { eventId }, { holds: [{ ...h, confirmedBookingId: bookingId }] })).passed).toBe(true);
  });

  it("flags a Hold that exists but whose seat is no longer 'held'", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const h = await liveHold([seatIds[0]!]);
    await db.query("UPDATE seats SET status = 'available' WHERE id = $1", [seatIds[0]]);
    expect(kinds(await checkAcknowledgedDurability(db, { eventId }, { holds: [h] }))).toContain("acknowledged-hold-seats-changed");
  });
});
