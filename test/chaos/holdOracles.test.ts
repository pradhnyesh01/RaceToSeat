// Negative controls for the Hold-lifecycle Oracle extensions (issue #50,
// ADR-0023): each check is run against a database corrupted by hand in
// exactly the way it exists to catch, plus a clean twin so it can't be
// "always red". Same scratch-database approach as oracles.test.ts — the
// production schema's constraints would refuse several of these states, so
// they are dropped in a throwaway copy, never in the shared database.
//
// Also pins the *shapes* a half-applied Reaper or Confirm would leave behind
// (seat reset but hold rows left, hold rows gone but seat still `held`) to the
// base Oracles that must catch them, since C3's runs rely on those branches.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkLiveConfirmYieldsOneBooking,
  checkNoConfirmAfterExpiry,
  confirmIntents,
  type HoldRecord,
} from "../../load-harness/chaos/holdOracles.js";
import { checkLiveness, checkMutualExclusion, type OracleResult } from "../../load-harness/chaos/oracles.js";
import { createScratchDb, IDEMPOTENCY_UNIQUE_CONSTRAINTS, SEAT_UNIQUE_CONSTRAINTS, type ScratchDb } from "../../load-harness/chaos/scratchDb.js";
import { confirmIdempotencyKey } from "../../src/strategies/pessimisticConfirm.js";

let scratch: ScratchDb;
let db: Pool;

beforeAll(async () => {
  scratch = await createScratchDb(process.env.DATABASE_URL!, [...SEAT_UNIQUE_CONSTRAINTS, ...IDEMPOTENCY_UNIQUE_CONSTRAINTS]);
  db = scratch.pool;
});

afterAll(async () => {
  await scratch?.drop();
});

async function seedEvent(seatCount: number): Promise<{ eventId: string; seatIds: string[] }> {
  const eventId = (await db.query<{ id: string }>("INSERT INTO events (name) VALUES ('hold oracle test') RETURNING id")).rows[0]!.id;
  const seats = await db.query<{ id: string }>(
    "INSERT INTO seats (event_id, label) SELECT $1, 'S' || gs FROM generate_series(1, $2) gs RETURNING id",
    [eventId, seatCount],
  );
  return { eventId, seatIds: seats.rows.map((row) => row.id) };
}

// A live-looking Hold on one seat (hold + hold_seats + seat marked held),
// returned as the HoldRecord the harness would have snapshotted at seeding.
async function seedHold(seatId: string, heldUntilSql: string): Promise<HoldRecord> {
  const holdId = (
    await db.query<{ id: string }>("INSERT INTO holds (idempotency_key) VALUES ($1) RETURNING id", [`seed-${randomUUID()}`])
  ).rows[0]!.id;
  await db.query("INSERT INTO hold_seats (hold_id, seat_id) VALUES ($1, $2)", [holdId, seatId]);
  await db.query(`UPDATE seats SET status = 'held', booked_by = 'u', held_until = ${heldUntilSql} WHERE id = $1`, [seatId]);
  const row = (
    await db.query<{ t: string; ms: string }>(
      "SELECT held_until::text AS t, (extract(epoch from held_until) * 1000)::bigint AS ms FROM seats WHERE id = $1",
      [seatId],
    )
  ).rows[0]!;
  return { holdId, seatIds: [seatId], userId: "u", heldUntilText: row.t, heldUntilMs: Number(row.ms) };
}

// A Booking under a Hold's synthesized confirm key, created at an exact instant.
async function insertConfirmBooking(hold: HoldRecord, createdAtSql: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO bookings (user_id, idempotency_key, created_at) VALUES ('u', $1, ${createdAtSql}) RETURNING id`,
      [confirmIdempotencyKey(hold.holdId)],
    )
  ).rows[0]!.id;
}

const kinds = (r: OracleResult) => r.violations.map((v) => v.kind);

describe("confirmIntents", () => {
  it("derives the ledger from the shared confirm-key template, not a copy of it", async () => {
    const { seatIds } = await seedEvent(1);
    const hold = await seedHold(seatIds[0]!, "now() + interval '1 hour'");
    expect(confirmIntents([hold])).toEqual([{ idempotencyKey: confirmIdempotencyKey(hold.holdId), seatIds: [seatIds[0]!] }]);
    expect(confirmIdempotencyKey(hold.holdId)).toBe(`hold-confirm:${hold.holdId}`);
  });
});

describe("Oracle 2 extension: no Booking from an expired Hold", () => {
  it("passes when there is no Booking at all (the expired Hold was never confirmed)", async () => {
    const { seatIds } = await seedEvent(1);
    const hold = await seedHold(seatIds[0]!, "now() - interval '1 minute'");
    expect((await checkNoConfirmAfterExpiry(db, [hold])).passed).toBe(true);
  });

  it("passes for a Booking confirmed while the Hold was still live", async () => {
    const { seatIds } = await seedEvent(1);
    const hold = await seedHold(seatIds[0]!, "now() + interval '1 hour'");
    await insertConfirmBooking(hold, "now()");
    expect((await checkNoConfirmAfterExpiry(db, [hold])).passed).toBe(true);
  });

  it("flags a Booking created after its Hold had expired", async () => {
    const { seatIds } = await seedEvent(1);
    const hold = await seedHold(seatIds[0]!, "now() - interval '1 minute'");
    const bookingId = await insertConfirmBooking(hold, "now()");
    const result = await checkNoConfirmAfterExpiry(db, [hold]);
    expect(kinds(result)).toEqual(["booking-confirmed-after-hold-expiry"]);
    expect(result.violations[0]!.bookingIds).toEqual([bookingId]);
    expect(result.violations[0]!.idempotencyKey).toBe(confirmIdempotencyKey(hold.holdId));
  });

  it("flags a Booking created at the very instant of expiry, and is exact to the microsecond", async () => {
    const { seatIds } = await seedEvent(3);
    const stamp = "'2030-01-01 00:00:00.123456+00'";
    const atExpiry = await seedHold(seatIds[0]!, stamp);
    const microAfter = await seedHold(seatIds[1]!, stamp);
    const microBefore = await seedHold(seatIds[2]!, stamp);
    await insertConfirmBooking(atExpiry, stamp);
    await insertConfirmBooking(microAfter, "'2030-01-01 00:00:00.123457+00'");
    await insertConfirmBooking(microBefore, "'2030-01-01 00:00:00.123455+00'");
    const result = await checkNoConfirmAfterExpiry(db, [atExpiry, microAfter, microBefore]);
    expect(result.violations.map((v) => v.idempotencyKey).sort()).toEqual(
      [confirmIdempotencyKey(atExpiry.holdId), confirmIdempotencyKey(microAfter.holdId)].sort(),
    );
  });

  it("only judges Bookings under the ledger's own confirm keys", async () => {
    const { seatIds } = await seedEvent(2);
    const judged = await seedHold(seatIds[0]!, "now() - interval '1 minute'");
    const other = await seedHold(seatIds[1]!, "now() - interval '1 minute'");
    await insertConfirmBooking(other, "now()");
    expect((await checkNoConfirmAfterExpiry(db, [judged])).passed).toBe(true);
  });
});

describe("Oracle 3 extension: a live Hold's retried Confirm yields exactly one Booking", () => {
  it("passes when a live Hold ended with exactly one Booking", async () => {
    const { seatIds } = await seedEvent(1);
    const hold = await seedHold(seatIds[0]!, "now() + interval '1 hour'");
    await insertConfirmBooking(hold, "now()");
    expect((await checkLiveConfirmYieldsOneBooking(db, [hold], [hold.holdId])).passed).toBe(true);
  });

  it("flags a live Hold whose retried Confirm left no Booking", async () => {
    const { seatIds } = await seedEvent(1);
    const hold = await seedHold(seatIds[0]!, "now() + interval '1 hour'");
    const result = await checkLiveConfirmYieldsOneBooking(db, [hold], [hold.holdId]);
    expect(kinds(result)).toEqual(["live-hold-confirm-retry-yielded-no-booking"]);
  });

  it("flags a live Hold whose retried Confirm produced two Bookings", async () => {
    const { seatIds } = await seedEvent(1);
    const hold = await seedHold(seatIds[0]!, "now() + interval '1 hour'");
    await insertConfirmBooking(hold, "now()");
    await insertConfirmBooking(hold, "now()");
    const result = await checkLiveConfirmYieldsOneBooking(db, [hold], [hold.holdId]);
    expect(kinds(result)).toEqual(["live-hold-confirm-retry-yielded-multiple-bookings"]);
    expect(result.violations[0]!.bookingIds).toHaveLength(2);
  });

  it("does not demand a Booking for a Hold the harness did not vouch for (expired, or its retry never answered)", async () => {
    const { seatIds } = await seedEvent(1);
    const hold = await seedHold(seatIds[0]!, "now() + interval '1 hour'");
    expect((await checkLiveConfirmYieldsOneBooking(db, [hold], [])).passed).toBe(true);
  });
});

describe("Hold-lifecycle shapes the base Oracles must still catch", () => {
  it("Oracle 4 flags a Seat left 'held' past its expiry with its Hold rows intact (reaper never ran / never finished)", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await seedHold(seatIds[0]!, "now() - interval '1 minute'");
    expect(kinds(await checkLiveness(db, { eventId }, { expiredHoldGraceSeconds: 2 }))).toEqual(["expired-hold-not-reaped"]);
  });

  it("Oracle 4 passes on the fully reaped end state (seat available, Hold rows gone) and on a fresh Hold", async () => {
    const { eventId, seatIds } = await seedEvent(2);
    await seedHold(seatIds[1]!, "now() + interval '1 hour'");
    // seatIds[0] was reaped: nothing held, nothing claiming it.
    expect((await checkLiveness(db, { eventId }, { expiredHoldGraceSeconds: 2 })).passed).toBe(true);
  });

  it("Oracle 1 flags a half-applied Reaper that reset the Seat but left its hold_seats row behind", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await seedHold(seatIds[0]!, "now() - interval '1 minute'");
    await db.query("UPDATE seats SET status = 'available', booked_by = NULL, held_until = NULL WHERE id = $1", [seatIds[0]!]);
    expect(kinds(await checkMutualExclusion(db, { eventId }))).toContain("hold-claim-but-seat-not-held");
  });

  it("Oracle 4 flags the opposite half-applied shape: hold rows deleted but the Seat still 'held'", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    await seedHold(seatIds[0]!, "now() - interval '1 minute'");
    await db.query("DELETE FROM hold_seats WHERE seat_id = $1", [seatIds[0]!]);
    expect(kinds(await checkLiveness(db, { eventId }, { expiredHoldGraceSeconds: 2 }))).toContain("held-seat-without-hold");
  });

  it("Oracle 1 flags a Confirm that booked a Seat while leaving its Hold behind (seat in both)", async () => {
    const { eventId, seatIds } = await seedEvent(1);
    const hold = await seedHold(seatIds[0]!, "now() + interval '1 hour'");
    const bookingId = await insertConfirmBooking(hold, "now()");
    await db.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [bookingId, seatIds[0]!]);
    expect(kinds(await checkMutualExclusion(db, { eventId }))).toContain("seat-booked-and-held");
  });
});
