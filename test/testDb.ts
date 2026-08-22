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
