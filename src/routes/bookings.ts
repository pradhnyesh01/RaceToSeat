import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { bookSeat } from "../strategies/index.js";

export const bookingsRouter = Router();

interface CreateBookingBody {
  seat_id?: unknown;
  user_id?: unknown;
  idempotency_key?: unknown;
}

bookingsRouter.post("/bookings", asyncHandler(async (req, res) => {
  const body = req.body as CreateBookingBody;

  if (
    typeof body.seat_id !== "string" ||
    typeof body.user_id !== "string" ||
    typeof body.idempotency_key !== "string"
  ) {
    res.status(400).json({
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
      res.status(201).json({ id: result.bookingId, created_at: result.createdAt });
      return;
    case "idempotent_replay":
      res.status(200).json({ id: result.bookingId, created_at: result.createdAt });
      return;
    case "conflict":
      res.status(409).json({ error: "Seat is not available" });
      return;
    case "not_found":
      res.status(404).json({ error: "Seat not found" });
      return;
  }
}));
