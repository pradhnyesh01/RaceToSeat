import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { findExistingBookingByIdempotencyKey, runTransactionalBooking } from "./idempotency.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";

export type { BookSeatResult };

export interface BookSeatOptimisticOptions {
  maxRetries?: number;
}

interface SeatState {
  status: string;
  version: number;
}

function readSeat(client: PoolClient, seatId: string): Promise<SeatState | undefined> {
  return client
    .query<SeatState>("SELECT status, version FROM seats WHERE id = $1", [seatId])
    .then((res) => res.rows[0]);
}

// ADR-0009: a CAS miss almost always means the seat is now permanently
// booked, where retrying is pointless. The one legitimate exception is a
// race with a concurrent cancellation, which also bumps `version` and
// returns the seat to 'available' — so on a miss we re-read and retry only
// if the fresh read still shows 'available'; a fresh 'booked' read is an
// ordinary conflict, resolved immediately without spending retry budget.
// Exhausting the budget on a miss (no budget left to even re-read and
// distinguish the two cases) is its own outcome (ADR-0012): the mechanism
// never learns whether the seat was genuinely taken.
export async function bookSeatOptimistic(
  input: BookSeatInput,
  options: BookSeatOptimisticOptions = {},
): Promise<BookSeatResult> {
  const maxRetries = options.maxRetries ?? config.optimisticMaxRetries;
  const client: PoolClient = await pool.connect();
  try {
    const existingBooking = await findExistingBookingByIdempotencyKey(client, input.idempotencyKey);
    if (existingBooking) {
      return { kind: "idempotent_replay", bookingId: existingBooking.id, createdAt: existingBooking.createdAt };
    }

    return await runTransactionalBooking(client, input.idempotencyKey, async (txClient) => {
      const initialSeat = await readSeat(txClient, input.seatId);
      if (!initialSeat) {
        return { kind: "not_found" };
      }

      let seat = initialSeat;
      let attempt = 0;
      while (true) {
        const casRes = await txClient.query(
          "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = $2 AND version = $3 AND status = 'available'",
          [input.userId, input.seatId, seat.version],
        );

        if (casRes.rowCount === 1) {
          const bookingRes = await txClient.query<{ id: string; created_at: Date }>(
            "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
            [input.userId, input.idempotencyKey],
          );
          const booking = bookingRes.rows[0]!;

          await txClient.query(
            "INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)",
            [booking.id, input.seatId],
          );

          return { kind: "created", bookingId: booking.id, createdAt: booking.created_at, retries: attempt };
        }

        if (attempt >= maxRetries) {
          return { kind: "retry_exhausted", retries: attempt };
        }

        seat = (await readSeat(txClient, input.seatId))!;
        if (seat.status !== "available") {
          return { kind: "conflict", retries: attempt };
        }
        attempt++;
      }
    });
  } finally {
    client.release();
  }
}
