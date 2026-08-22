import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { pool } from "../db/pool.js";

export const seatsRouter = Router();

seatsRouter.get("/seats", asyncHandler(async (req, res) => {
  const eventId = req.query.event_id;
  if (typeof eventId !== "string") {
    res.status(400).json({ error: "event_id query parameter is required" });
    return;
  }

  // Read path must not be blocked by writes on unrelated seats (FR3) — a
  // plain unlocked SELECT satisfies that for every mechanism, since none of
  // the five in-scope strategies take a lock that a bare read would wait on.
  const { rows } = await pool.query(
    "SELECT id, label, status, version, booked_by FROM seats WHERE event_id = $1 ORDER BY label",
    [eventId],
  );

  res.status(200).json({ seats: rows });
}));
