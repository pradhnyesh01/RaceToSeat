import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "../db/pool.js";
import { isInvalidTextRepresentation } from "../db/pgErrors.js";
import { bookSeat } from "../strategies/index.js";

interface CreateBookingBody {
  seat_id?: unknown;
  user_id?: unknown;
  idempotency_key?: unknown;
}

export function registerBookingsRoutes(app: FastifyInstance): void {
  app.post("/bookings", async (request, reply) => {
    const body = request.body as CreateBookingBody;

    if (
      typeof body?.seat_id !== "string" ||
      typeof body?.user_id !== "string" ||
      typeof body?.idempotency_key !== "string"
    ) {
      reply.status(400).send({
        error: "seat_id, user_id, and idempotency_key are all required strings",
      });
      return;
    }

    const result = await bookSeat({
      seatId: body.seat_id,
      userId: body.user_id,
      idempotencyKey: body.idempotency_key,
    });

    switch (result.kind) {
      case "created":
        reply.status(201).send({ id: result.bookingId, created_at: result.createdAt });
        return;
      case "idempotent_replay":
        // Issue #4: a retry with the same idempotency_key returns the
        // original booking's 201, not a 200 — the client can't tell this
        // apart from its first attempt succeeding.
        reply.status(201).send({ id: result.bookingId, created_at: result.createdAt });
        return;
      case "conflict":
        reply.status(409).send({ error: "Seat is not available" });
        return;
      case "not_found":
        reply.status(404).send({ error: "Seat not found" });
        return;
    }
  });

  // Cancellation is implemented once, independent of BOOKING_STRATEGY: a
  // booking is uniquely identified by its own id, so there's no multi-writer
  // race to arbitrate here the way seat-claiming has. No ownership/user_id
  // check — any caller holding a valid booking id can cancel it.
  app.delete("/bookings/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const client = await pool.connect();
    try {
      let found: boolean;
      try {
        found = await withTransaction(
          client,
          async (txClient) => {
            const seatIdsRes = await txClient.query<{ seat_id: string }>(
              "DELETE FROM booking_seats WHERE booking_id = $1 RETURNING seat_id",
              [id],
            );

            if (seatIdsRes.rows.length === 0) {
              return false;
            }

            const seatIds = seatIdsRes.rows.map((row) => row.seat_id);
            await txClient.query(
              "UPDATE seats SET status = 'available', booked_by = NULL, version = version + 1 WHERE id = ANY($1)",
              [seatIds],
            );
            await txClient.query("DELETE FROM bookings WHERE id = $1", [id]);
            return true;
          },
          (foundResult) => foundResult,
        );
      } catch (err) {
        if (isInvalidTextRepresentation(err)) {
          reply.status(404).send({ error: "Booking not found" });
          return;
        }
        throw err;
      }

      if (!found) {
        // Deliberately not idempotent (unlike the idempotency-key retry
        // path): a second DELETE on an already-canceled id must 404 again,
        // not silently succeed. A booking and its booking_seats rows are
        // always deleted together above, so no booking_seats rows means the
        // id is unknown or already canceled either way.
        reply.status(404).send({ error: "Booking not found" });
        return;
      }
      reply.status(204).send();
    } finally {
      client.release();
    }
  });
}
