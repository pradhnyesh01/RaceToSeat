import Fastify from "fastify";
import { strategySupportsHolds } from "./config.js";
import { isInfrastructureFailure, isTimeoutFailure } from "./db/pgErrors.js";
import { registerBookingsRoutes } from "./routes/bookings.js";
import { registerHoldsRoutes } from "./routes/holds.js";
import { registerSeatsRoutes } from "./routes/seats.js";

export function createApp() {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    console.error(err);
    // One of the database bounds fired (ADR-0026): the server cancelled a
    // statement or ended an idle transaction, or the client gave up waiting on a
    // stalled connection or a full pool. 504, not 502: the database may well be
    // reachable, it just did not answer in time - and above all never a 409,
    // which a lock_timeout's 55P03 could otherwise be mistaken for. Same retry
    // contract as 502: the outcome is unknown (a COMMIT may have landed), so
    // retrying with the same idempotency key is the safe way to find out.
    if (isTimeoutFailure(err)) {
      reply
        .header("Retry-After", "1")
        .status(504)
        .send({
          error: "Database did not answer in time; the request's outcome is unknown. Retry with the same idempotency key.",
          outcome: "timeout",
        });
      return;
    }
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
