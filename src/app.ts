import Fastify from "fastify";
import { config } from "./config.js";
import { registerBookingsRoutes } from "./routes/bookings.js";
import { registerHoldsRoutes } from "./routes/holds.js";
import { registerSeatsRoutes } from "./routes/seats.js";

export function createApp() {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    console.error(err);
    reply.status(500).send({ error: "Internal server error" });
  });

  registerSeatsRoutes(app);
  registerBookingsRoutes(app);

  // The hold flow is implemented for `pessimistic` only (ADR-0017); its
  // routes simply don't exist — a plain 404 — under any other
  // BOOKING_STRATEGY, keeping that env var the single honest source of truth
  // for which mechanism a running process actually executes (ADR-0019).
  if (config.bookingStrategy === "pessimistic") {
    registerHoldsRoutes(app);
  }

  return app;
}
