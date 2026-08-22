import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

export type BookSeatResult =
  | { kind: "created"; bookingId: string; createdAt: Date }
  | { kind: "idempotent_replay"; bookingId: string; createdAt: Date }
  | { kind: "conflict" }
  | { kind: "not_found" };

interface BookSeatInput {
  seatId: string;
  userId: string;
  idempotencyKey: string;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505" &&
    "constraint" in err &&
    (err as { constraint?: string }).constraint === constraint
  );
}

// Deliberately naive: reads seat status, then writes, with no locking and no
// transaction isolation guarding the gap between the two. Two concurrent
// requests for the same seat can both observe 'available' before either
// commits its write — this is Phase 0's Exhibit A bug, fixed starting in
// Phase 1 (todo.md).
export async function bookSeatNaive(input: BookSeatInput): Promise<BookSeatResult> {
  const client: PoolClient = await pool.connect();
  try {
    const seatRes = await client.query<{ status: string }>(
      "SELECT status FROM seats WHERE id = $1",
      [input.seatId],
    );
    const seat = seatRes.rows[0];
    if (!seat) {
      return { kind: "not_found" };
    }
    if (seat.status !== "available") {
      return { kind: "conflict" };
    }

    try {
      const bookingRes = await client.query<{ id: string; created_at: Date }>(
        "INSERT INTO bookings (user_id, idempotency_key) VALUES ($1, $2) RETURNING id, created_at",
        [input.userId, input.idempotencyKey],
      );
      const booking = bookingRes.rows[0]!;

      await client.query(
        "INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1, $2)",
        [booking.id, input.seatId],
      );
      await client.query(
        "UPDATE seats SET status = 'booked', booked_by = $1, version = version + 1 WHERE id = $2",
        [input.userId, input.seatId],
      );

      return { kind: "created", bookingId: booking.id, createdAt: booking.created_at };
    } catch (err) {
      if (isUniqueViolation(err, "bookings_idempotency_key_key")) {
        const existing = await client.query<{ id: string; created_at: Date }>(
          "SELECT id, created_at FROM bookings WHERE idempotency_key = $1",
          [input.idempotencyKey],
        );
        const booking = existing.rows[0]!;
        return { kind: "idempotent_replay", bookingId: booking.id, createdAt: booking.created_at };
      }
      throw err;
    }
  } finally {
    client.release();
  }
}
