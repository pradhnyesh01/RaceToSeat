import express, { type ErrorRequestHandler } from "express";
import { bookingsRouter } from "./routes/bookings.js";
import { seatsRouter } from "./routes/seats.js";

const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(seatsRouter);
  app.use(bookingsRouter);
  app.use(handleError);
  return app;
}
