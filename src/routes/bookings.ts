import type { FastifyInstance } from "fastify";
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
}
