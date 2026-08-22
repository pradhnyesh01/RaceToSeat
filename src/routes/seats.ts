import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";

export function registerSeatsRoutes(app: FastifyInstance): void {
  app.get("/seats", async (request, reply) => {
    const { event_id: eventId } = request.query as { event_id?: unknown };
    if (typeof eventId !== "string") {
      reply.status(400).send({ error: "event_id query parameter is required" });
      return;
    }

    // Read path must not be blocked by writes on unrelated seats (FR3) — a
    // plain unlocked SELECT satisfies that for every mechanism, since none of
    // the five in-scope strategies take a lock that a bare read would wait on.
    const { rows } = await pool.query(
      "SELECT id, label, status, version, booked_by FROM seats WHERE event_id = $1 ORDER BY label",
      [eventId],
    );

    reply.status(200).send({ seats: rows });
  });
}
