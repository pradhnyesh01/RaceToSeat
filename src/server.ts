import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`RaceToSeat listening on :${config.port} (strategy: ${config.bookingStrategy})`);
});
