import type { FastifyInstance } from "fastify";
import { isInvalidTextRepresentation } from "../db/pgErrors.js";
import { confirmHoldPessimistic } from "../strategies/pessimisticConfirm.js";
import { holdSeatsPessimistic } from "../strategies/pessimisticHold.js";
import { validateSeatClaimBody } from "./validation.js";

// Only ever called when BOOKING_STRATEGY=pessimistic (app.ts gates the call
// site, ADR-0019) — every route registered here 404s under any other
// strategy simply by not existing, no runtime check needed inside the
// handlers themselves.
export function registerHoldsRoutes(app: FastifyInstance): void {
  app.post("/holds", async (request, reply) => {
    const validation = validateSeatClaimBody(request.body);
    if (!validation.ok) {
      reply.status(400).send({ error: validation.error });
      return;
    }

    const result = await holdSeatsPessimistic(validation.value);

    switch (result.kind) {
      case "created":
      case "idempotent_replay":
        // Issue #38 spec: unlike POST /bookings' {id, created_at} body, a
        // hold's response also carries seat_ids and held_until — there's no
        // later read endpoint (no GET /holds/{id}) for a client to learn
        // either otherwise.
        reply.status(201).send({ id: result.holdId, seat_ids: result.seatIds, held_until: result.heldUntil });
        return;
      case "key_released":
        // ADR-0030: the key's Hold was confirmed or expired and reaped. 410,
        // same contract as POST /bookings' key_released.
        reply.status(410).send({
          error: `This idempotency key was already used by a hold that has since been ${result.reason}`,
          outcome: "key_released",
          reason: result.reason,
          released_id: result.releasedId,
        });
        return;
      case "conflict":
        reply.status(409).send({ error: "Seat is not available" });
        return;
      case "not_found":
        reply.status(404).send({ error: "Seat not found" });
        return;
    }
  });

  // Bodyless: confirm is identified entirely by the hold id in the path, no
  // ownership check (mirrors DELETE /bookings/{id}'s precedent — the id
  // alone is the capability).
  app.post("/holds/:id/confirm", async (request, reply) => {
    const { id } = request.params as { id: string };

    let result;
    try {
      result = await confirmHoldPessimistic(id);
    } catch (err) {
      // Same rationale as DELETE /bookings/{id}: a malformed (non-UUID) id
      // throws 22P02 from the first UUID-typed column comparison, caught
      // here rather than surfacing as a 500.
      if (isInvalidTextRepresentation(err)) {
        reply.status(404).send({ error: "Hold not found" });
        return;
      }
      throw err;
    }

    // Every mechanism's booking-creating endpoint carries this header
    // (ADR-0012) — always "0" here, since pessimistic never retries.
    reply.header("X-Booking-Retries", "0");

    switch (result.kind) {
      case "created":
      case "idempotent_replay":
        reply.status(201).send({ id: result.bookingId, created_at: result.createdAt });
        return;
      case "expired":
        reply.status(410).send({ error: "Hold has expired" });
        return;
      case "conflict":
        reply.status(409).send({ error: "Hold is being confirmed by another request" });
        return;
      case "not_found":
        reply.status(404).send({ error: "Hold not found" });
        return;
    }
  });
}
