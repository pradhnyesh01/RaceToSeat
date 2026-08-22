import { Client } from "pg";
import "dotenv/config";

const SEAT_COUNT = 50;

const client = new Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
try {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO events (name) VALUES ($1) RETURNING id",
    ["Opening Night: Phase 0 Demo"],
  );
  const eventId = rows[0]!.id;

  const labels = Array.from({ length: SEAT_COUNT }, (_, i) => `${String.fromCharCode(65 + Math.floor(i / 10))}${(i % 10) + 1}`);
  for (const label of labels) {
    await client.query("INSERT INTO seats (event_id, label) VALUES ($1, $2)", [eventId, label]);
  }

  console.log(`Seeded event ${eventId} with ${SEAT_COUNT} seats.`);
} finally {
  await client.end();
}
