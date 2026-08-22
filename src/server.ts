import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();

app.listen({ port: config.port }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`RaceToSeat listening on :${config.port} (strategy: ${config.bookingStrategy})`);
});
