import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import "dotenv/config";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const schema = readFileSync(schemaPath, "utf8");

const client = new Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
try {
  await client.query("DROP TABLE IF EXISTS booking_seats, bookings, seats, events CASCADE");
  await client.query("DROP TYPE IF EXISTS seat_status");
  await client.query(schema);
  console.log("Migration applied.");
} finally {
  await client.end();
}
