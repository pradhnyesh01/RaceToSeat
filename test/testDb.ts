import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../src/db/pool.js";

export async function resetDb(): Promise<void> {
  await pool.query("TRUNCATE booking_seats, bookings, seats, events RESTART IDENTITY CASCADE");
}

export async function seedEventWithSeats(seatLabels: string[]): Promise<{ eventId: string; seatIdsByLabel: Record<string, string> }> {
  const eventRes = await pool.query<{ id: string }>(
    "INSERT INTO events (name) VALUES ($1) RETURNING id",
    ["Test Event"],
  );
  const eventId = eventRes.rows[0]!.id;

  const seatIdsByLabel: Record<string, string> = {};
  for (const label of seatLabels) {
    const seatRes = await pool.query<{ id: string }>(
      "INSERT INTO seats (event_id, label) VALUES ($1, $2) RETURNING id",
      [eventId, label],
    );
    seatIdsByLabel[label] = seatRes.rows[0]!.id;
  }

  return { eventId, seatIdsByLabel };
}

// Seeds a booking directly against the DB, bypassing the API — the only way
// to construct a multi-seat booking before Phase 3 adds multi-seat requests.
export async function seedBooking(seatIds: string[], userId: string): Promise<{ bookingId: string }> {
  const bookingRes = await pool.query<{ id: string }>(
    "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id",
    [userId, `seed-${randomUUID()}`],
  );
  const bookingId = bookingRes.rows[0]!.id;

  for (const seatId of seatIds) {
    await pool.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [bookingId, seatId]);
    await pool.query(
      "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = $2",
      [userId, seatId],
    );
  }

  return { bookingId };
}

// Runs the same insert-booking/insert-booking_seats/update-seat write every
// mechanism does, directly on an already-`BEGIN`'d client — the caller owns
// the transaction boundary (BEGIN/COMMIT and its isolation level), since
// that's typically the part a deterministic-race test cares about varying.
export async function commitBookingOnClient(client: PoolClient, seatId: string, userId: string): Promise<void> {
  const bookingRes = await client.query<{ id: string }>(
    "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id",
    [userId, `race-winner-${randomUUID()}`],
  );
  await client.query("INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)", [
    bookingRes.rows[0]!.id,
    seatId,
  ]);
  await client.query(
    "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = $2",
    [userId, seatId],
  );
}

// Stages a deterministic race against a mechanism under test by intercepting
// the *next* query it issues whose SQL starts with `sqlPrefix` (and, if
// given, that satisfies `when(result)` — e.g. "only a CAS miss, not a hit").
// The first time that happens, `onMatch` runs with a fresh, unintercepted
// connection (bypassing the patched `pool.connect`) so it can commit a real,
// independent transaction — a genuine concurrent event, not a stub — before
// the intercepted query's caller continues. A plain Promise.all race can't
// reliably force this kind of window (see optimistic.test.ts's and
// serializable's own tests for why), so this patches `pool.connect` itself
// for the scope between the returned `restore()` calls. Always restore in a
// `finally`, even on an exception path — an unrestored patch persists on the
// shared `pool` singleton for the rest of the process. Note `restore()` only
// undoes the `pool.connect` patch, not the `query` wrapper applied to each
// individual client it hands out — harmless in practice, since `triggered`
// guards against firing twice, but a client checked out during an active
// intercept keeps its wrapped `query` for the rest of the process even after
// `restore()`, should the pool ever hand that same client back out later.
export function interceptQuery(
  sqlPrefix: string,
  onMatch: (connect: () => Promise<PoolClient>) => Promise<void>,
  when: (result: unknown) => boolean = () => true,
): { restore: () => void; wasTriggered: () => boolean } {
  const originalConnect = pool.connect.bind(pool);
  let triggered = false;

  (pool as unknown as { connect: typeof pool.connect }).connect = (async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    (client as unknown as { query: unknown }).query = async (...queryArgs: unknown[]) => {
      const result = await (originalQuery as (...args: unknown[]) => Promise<unknown>)(...queryArgs);
      if (!triggered) {
        const first = queryArgs[0];
        const sql = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
        if (sql?.startsWith(sqlPrefix) && when(result)) {
          triggered = true;
          await onMatch(originalConnect);
        }
      }
      return result;
    };
    return client;
  }) as typeof pool.connect;

  return {
    restore: () => {
      pool.connect = originalConnect;
    },
    wasTriggered: () => triggered,
  };
}
