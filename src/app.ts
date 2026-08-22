import Fastify from "fastify";
import { registerBookingsRoutes } from "./routes/bookings.js";
import { registerSeatsRoutes } from "./routes/seats.js";

export function createApp() {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    console.error(err);
    reply.status(500).send({ error: "Internal server error" });
  });

  registerSeatsRoutes(app);
  registerBookingsRoutes(app);

  return app;
}
