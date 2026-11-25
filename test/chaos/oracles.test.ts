// Negative controls for the four chaos Oracles (issue #44, ADR-0023): each
// Oracle is run against a database state corrupted *by hand* in exactly the
// way it exists to catch, and must flag it. A checker never shown to fail
// proves nothing — an Oracle that quietly returned "pass" on everything
// would make every clean chaos run meaningless.
//
// The production schema's constraints would refuse most of these states
// (UNIQUE(seat_id), UNIQUE(idempotency_key) — ADR-0008), which is the point
// of having them, so the corruption happens in a scratch database derived
// from db/schema.sql with those constraints dropped (scratchDb.ts) — never in
// the shared test database, and with no production code or schema change.
// Every test also has a clean-state twin proving the Oracle doesn't just
// fire unconditionally.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkIdempotentRecovery,
  checkLiveness,
  checkMutualExclusion,
  checkNoTornState,
  runOracles,
  snapshotBookingsByKey,
  type BookingIntent,
  type OracleResult,
} from "../../load-harness/chaos/oracles.js";
import {
  createScratchDb,
  IDEMPOTENCY_UNIQUE_CONSTRAINTS,
  SEAT_UNIQUE_CONSTRAINTS,
  type ScratchDb,
} from "../../load-harness/chaos/scratchDb.js";

let scratch: ScratchDb;
let db: Pool;

beforeAll(async () => {
  scratch = await createScratchDb(process.env.DATABASE_URL!, [
    ...SEAT_UNIQUE_CONSTRAINTS,
    ...IDEMPOTENCY_UNIQUE_CONSTRAINTS,
  ]);
  db = scratch.pool;
});

afterAll(async () => {
  await scratch?.drop();
});

// Every test works in its own event, so Oracle scoping also keeps tests from
// seeing each other's deliberately corrupt rows.
async function seedEvent(seatCount: number): Promise<{ eventId: string; seatIds: string[] }> {
  const eventId = (await db.query<{ id: string }>("INSERT INTO events (name) VALUES ('oracle test') RETURNING id")).rows[0]!.id;
  const seats = await db.query<{ id: string }>(
    "INSERT INTO seats (event_id, label) SELECT $1, 'S' || gs FROM generate_series(1, $2) gs RETURNING id",
    [eventId, seatCount],
  );
  return { eventId, seatIds: seats.rows.map((row) => row.id) };
}

// Inserts a Booking and its claims, then (by default) marks the seats booked
// the way every real mechanism does — so a test can corrupt exactly one
// thing by opting out of one step.
async function insertBooking(
  key: string,
  seatIds: string[],
  options: { userId?: string; markSeats?: boolean } = {},
): Promise<string> {
  const userId = options.userId ?? "user-1";
  const id = (
    await db.query<{ id: string }>("INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id", [userId, key])
  ).rows[0]!.id;
  for (const seatId of seatIds) {
    await db.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [id, seatId]);
  }
  if (options.markSeats ?? true) {
    await db.query("UPDATE seats SET status = 'booked', booked_by = $1 WHERE id = ANY($2)", [userId, seatIds]);
  }
  return id;
}

async function insertHold(
  key: string,
  seatIds: string[],
  options: { markSeats?: boolean; heldUntil?: string } = {},
): Promise<string> {
  const id = (await db.query<{ id: string }>("INSERT INTO holds (idempotency_key) VALUES ($1) RETURNING id", [key])).rows[0]!.id;
  for (const seatId of seatIds) {
    await db.query("INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)", [id, seatId]);
  }
  if (options.markSeats ?? true) {
    await db.query(
      `UPDATE seats SET status = 'held', held_until = ${options.heldUntil ?? "now() + interval '5 minutes'"} WHERE id = ANY($1)`,
      [seatIds],
    );
  }
  return id;
}

const key = () => `key-${randomUUID()}`;

function kinds(result: OracleResult): string[] {
  return result.violations.map((v) => v.kind);
}

describe("Oracle 1: mutual exclusion", () => {
  it("passes on a clean state with bookings and holds on distinct seats", async () => {
    const { eventId, seatIds } = await seedEvent(4);
    await insertBooking(key(), [seatIds[0]!, seatIds[1]!]);
    await insertHold(key(), [seatIds[2]!]);
    const result = await checkMutualExclusion(db, { eventId });
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("flags a seat claimed by two bookings (the classic double-booking)", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await insertBooking(key(), [seatIds[0]!], { userId: "alice" });
    await insertBooking(key(), [seatIds[0]!], { userId: "bob", markSeats: false });
    const result = await checkMutualExclusion(db, { eventId });
    expect(result.passed).toBe(false);
    expect(kinds(result)).toContain("seat-in-multiple-bookings");
    expect(result.violations[0]!.bookingIds).toHaveLength(2);
  });

  it("flags a seat claimed by two holds", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await insertHold(key(), [seatIds[0]!]);
    await insertHold(key(), [seatIds[0]!], { markSeats: false });
    expect(kinds(await checkMutualExclusion(db, { eventId }))).toContain("seat-in-multiple-holds");
  });

  it("flags a seat claimed by a booking and a hold at once", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await insertBooking(key(), [seatIds[0]!]);
    await insertHold(key(), [seatIds[0]!], { markSeats: false });
    expect(kinds(await checkMutualExclusion(db, { eventId }))).toContain("seat-booked-and-held");
  });

  it("flags a booking claim whose seat row still says 'available' (seats disagree)", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await insertBooking(key(), [seatIds[0]!], { markSeats: false });
    expect(kinds(await checkMutualExclusion(db, { eventId }))).toEqual(["booking-claim-but-seat-not-booked"]);
  });

  it("flags a hold claim whose seat row says 'available' (seats disagree)", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await insertHold(key(), [seatIds[0]!], { markSeats: false });
    expect(kinds(await checkMutualExclusion(db, { eventId }))).toEqual(["hold-claim-but-seat-not-held"]);
  });

  it("flags a seat whose booked_by names a different user than its booking", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await insertBooking(key(), [seatIds[0]!], { userId: "alice" });
    await db.query("UPDATE seats SET booked_by = 'mallory' WHERE id = $1", [seatIds[0]!]);
    expect(kinds(await checkMutualExclusion(db, { eventId }))).toEqual(["seat-owner-disagrees-with-booking"]);
  });

  it("ignores corruption in another event", async () => {
    const clean = await seedEvent(1);
    const dirty = await seedEvent(1);
    await insertBooking(key(), [dirty.seatIds[0]!]);
    await insertBooking(key(), [dirty.seatIds[0]!], { markSeats: false });
    expect((await checkMutualExclusion(db, { eventId: clean.eventId })).passed).toBe(true);
    expect((await checkMutualExclusion(db, { eventId: dirty.eventId })).passed).toBe(false);
  });
});

describe("Oracle 2: no torn state", () => {
  it("passes when every booking holds exactly the seats it requested", async () => {
    const { eventId, seatIds } = await seedEvent(3);
    const k = key();
    await insertBooking(k, [seatIds[0]!, seatIds[1]!, seatIds[2]!]);
    const ledger: BookingIntent[] = [{ idempotencyKey: k, seatIds: [seatIds[2]!, seatIds[0]!, seatIds[1]!] }];
    expect((await checkNoTornState(db, { eventId }, ledger)).violations).toEqual([]);
  });

  it("flags a multi-seat booking that holds fewer seats than it requested", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const k = key();
    await insertBooking(k, [seatIds[0]!]);
    const result = await checkNoTornState(db, { eventId }, [{ idempotencyKey: k, seatIds: [seatIds[0]!, seatIds[1]!] }]);
    expect(kinds(result)).toEqual(["booking-missing-requested-seats"]);
    expect(result.violations[0]!.seatIds).toEqual([seatIds[1]!.toLowerCase()]);
  });

  it("flags a booking row with no seats at all (header committed, claims lost)", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const k = key();
    await insertBooking(k, []);
    const result = await checkNoTornState(db, { eventId }, [{ idempotencyKey: k, seatIds }]);
    expect(kinds(result)).toEqual(["booking-missing-requested-seats"]);
  });

  it("flags a booking holding a seat it never requested", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const k = key();
    await insertBooking(k, [seatIds[0]!, seatIds[1]!]);
    const result = await checkNoTornState(db, { eventId }, [{ idempotencyKey: k, seatIds: [seatIds[0]!] }]);
    expect(kinds(result)).toEqual(["booking-has-unrequested-seats"]);
  });

  it("flags a 'booked' seat that no booking claims", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    await db.query("UPDATE seats SET status = 'booked', booked_by = 'ghost' WHERE id = $1", [seatIds[0]!]);
    const result = await checkNoTornState(db, { eventId }, []);
    expect(kinds(result)).toEqual(["booked-seat-without-booking"]);
    expect(result.violations[0]!.seatIds).toEqual([seatIds[0]!]);
  });

  it("does not judge bookings outside the ledger", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    await insertBooking(key(), [seatIds[0]!]);
    expect((await checkNoTornState(db, { eventId }, [])).passed).toBe(true);
  });
});

describe("Oracle 3: idempotent recovery", () => {
  it("passes when the replay finds the original booking untouched", async () => {
    const { seatIds } = await seedEvent(1);
    const k = key();
    await insertBooking(k, [seatIds[0]!]);
    const ledger = [{ idempotencyKey: k, seatIds }];
    const before = await snapshotBookingsByKey(db, [k]);
    expect((await checkIdempotentRecovery(db, ledger, before)).violations).toEqual([]);
  });

  it("passes when a key with no booking before the replay gained exactly one (its first attempt never committed)", async () => {
    const { seatIds } = await seedEvent(1);
    const k = key();
    const ledger = [{ idempotencyKey: k, seatIds }];
    const before = await snapshotBookingsByKey(db, [k]);
    await insertBooking(k, [seatIds[0]!]);
    expect((await checkIdempotentRecovery(db, ledger, before)).passed).toBe(true);
  });

  it("passes for a key that legitimately never got a booking (it lost its seat)", async () => {
    const { seatIds } = await seedEvent(1);
    const k = key();
    const before = await snapshotBookingsByKey(db, [k]);
    expect((await checkIdempotentRecovery(db, [{ idempotencyKey: k, seatIds }], before)).passed).toBe(true);
  });

  it("flags a key that produced two bookings (the replay duplicated it)", async () => {
    const { seatIds } = await seedEvent(2);
    const k = key();
    await insertBooking(k, [seatIds[0]!]);
    const before = await snapshotBookingsByKey(db, [k]);
    await insertBooking(k, [seatIds[1]!]);
    const result = await checkIdempotentRecovery(db, [{ idempotencyKey: k, seatIds }], before);
    expect(kinds(result)).toEqual(["idempotency-key-produced-multiple-bookings"]);
    expect(result.violations[0]!.bookingIds).toHaveLength(2);
  });

  it("flags a key whose original booking was replaced by the replay", async () => {
    const { seatIds } = await seedEvent(1);
    const k = key();
    const original = await insertBooking(k, [seatIds[0]!]);
    const before = await snapshotBookingsByKey(db, [k]);
    await db.query("DELETE FROM booking_seats WHERE booking_id = $1", [original]);
    await db.query("DELETE FROM bookings WHERE id = $1", [original]);
    await insertBooking(k, [seatIds[0]!]);
    const result = await checkIdempotentRecovery(db, [{ idempotencyKey: k, seatIds }], before);
    expect(kinds(result)).toEqual(["replay-changed-existing-booking"]);
  });

  it("flags a key whose original booking vanished", async () => {
    const { seatIds } = await seedEvent(1);
    const k = key();
    const original = await insertBooking(k, [seatIds[0]!]);
    const before = await snapshotBookingsByKey(db, [k]);
    await db.query("DELETE FROM booking_seats WHERE booking_id = $1", [original]);
    await db.query("DELETE FROM bookings WHERE id = $1", [original]);
    expect(kinds(await checkIdempotentRecovery(db, [{ idempotencyKey: k, seatIds }], before))).toEqual([
      "replay-changed-existing-booking",
    ]);
  });

  it("flags a key whose booking's seat set changed across the replay", async () => {
    const { seatIds } = await seedEvent(2);
    const k = key();
    const original = await insertBooking(k, [seatIds[0]!]);
    const before = await snapshotBookingsByKey(db, [k]);
    await db.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [original, seatIds[1]!]);
    expect(kinds(await checkIdempotentRecovery(db, [{ idempotencyKey: k, seatIds }], before))).toEqual([
      "replay-changed-existing-booking",
    ]);
  });
});

describe("Oracle 4: liveness", () => {
  it("passes on a clean state", async () => {
    const { eventId, seatIds } = await seedEvent(3);
    await insertBooking(key(), [seatIds[0]!]);
    await insertHold(key(), [seatIds[1]!]);
    expect((await checkLiveness(db, { eventId })).violations).toEqual([]);
  });

  it("flags a 'held' seat that no hold claims", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await db.query("UPDATE seats SET status = 'held', held_until = now() + interval '5 minutes' WHERE id = $1", [seatIds[0]!]);
    expect(kinds(await checkLiveness(db, { eventId }))).toEqual(["held-seat-without-hold"]);
  });

  it("flags a hold that expired long ago and was never reaped", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await insertHold(key(), [seatIds[0]!], { heldUntil: "now() - interval '1 hour'" });
    expect(kinds(await checkLiveness(db, { eventId }))).toEqual(["expired-hold-not-reaped"]);
  });

  it("tolerates a just-expired hold within the reaper's grace window", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await insertHold(key(), [seatIds[0]!], { heldUntil: "now() - interval '1 second'" });
    expect((await checkLiveness(db, { eventId }, { expiredHoldGraceSeconds: 10 })).passed).toBe(true);
    expect(kinds(await checkLiveness(db, { eventId }, { expiredHoldGraceSeconds: 0 }))).toEqual(["expired-hold-not-reaped"]);
  });

  it("flags a seat still row-locked by a transaction that never ended (a leaked lock), and clears once it ends", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const leaker: PoolClient = await db.connect();
    try {
      await leaker.query("BEGIN");
      await leaker.query("SELECT 1 FROM seats WHERE id = $1 FOR UPDATE", [seatIds[1]!]);
      const stuck = await checkLiveness(db, { eventId });
      expect(kinds(stuck)).toEqual(["seat-row-locked-after-recovery"]);
      expect(stuck.violations[0]!.seatIds).toEqual([seatIds[1]!]);
    } finally {
      await leaker.query("ROLLBACK");
      leaker.release();
    }
    expect((await checkLiveness(db, { eventId })).passed).toBe(true);
  });
});

describe("runOracles", () => {
  it("returns all four Oracles in order, all passing on a clean state", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    const k = key();
    await insertBooking(k, seatIds);
    const ledger = [{ idempotencyKey: k, seatIds }];
    const before = await snapshotBookingsByKey(db, [k]);
    const results = await runOracles(db, { scope: { eventId }, ledger, before });
    expect(results.map((r) => r.oracle)).toEqual([1, 2, 3, 4]);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("fails the right Oracle, and only it, for a double-booking", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const k1 = key();
    const k2 = key();
    await insertBooking(k1, [seatIds[0]!], { userId: "alice" });
    await insertBooking(k2, [seatIds[0]!], { userId: "bob", markSeats: false });
    const ledger = [
      { idempotencyKey: k1, seatIds },
      { idempotencyKey: k2, seatIds },
    ];
    const before = await snapshotBookingsByKey(db, [k1, k2]);
    const results = await runOracles(db, { scope: { eventId }, ledger, before });
    expect(results.filter((r) => !r.passed).map((r) => r.oracle)).toEqual([1]);
  });
});
