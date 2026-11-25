import Fastify from "fastify";
import { strategySupportsHolds } from "./config.js";
import { isInfrastructureFailure } from "./db/pgErrors.js";
import { registerBookingsRoutes } from "./routes/bookings.js";
import { registerHoldsRoutes } from "./routes/holds.js";
import { registerSeatsRoutes } from "./routes/seats.js";

export function createApp() {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    console.error(err);
    // The database could not be reached or went away mid-request (ADR-0025):
    // not a bug in this request (500), not a lost race (409), and deliberately
    // not 503, which is retry_exhausted's alone (ADR-0012/0015). The request's
    // outcome is unknown — a COMMIT may or may not have landed — so retrying
    // with the same idempotency key is the safe way to find out.
    if (isInfrastructureFailure(err)) {
      reply
        .header("Retry-After", "1")
        .status(502)
        .send({
          error: "Database unavailable; the request's outcome is unknown. Retry with the same idempotency key.",
          outcome: "infrastructure_failure",
        });
      return;
    }
    reply.status(500).send({ error: "Internal server error" });
  });

  registerSeatsRoutes(app);
  registerBookingsRoutes(app);

  // The hold flow is implemented for `pessimistic` only (ADR-0017); its
  // routes simply don't exist — a plain 404 — under any other
  // BOOKING_STRATEGY, keeping that env var the single honest source of truth
  // for which mechanism a running process actually executes (ADR-0019).
  if (strategySupportsHolds()) {
    registerHoldsRoutes(app);
  }

  return app;
}
