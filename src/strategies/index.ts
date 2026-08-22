import { config } from "../config.js";
import { bookSeatNaive, type BookSeatResult } from "./naive.js";

export type { BookSeatResult };

interface BookSeatInput {
  seatId: string;
  userId: string;
  idempotencyKey: string;
}

type Strategy = (input: BookSeatInput) => Promise<BookSeatResult>;

// Strategy is selected once at process startup (ADR-0002), not per request.
// Phase 0 ships only "naive"; Phase 1+ add the remaining four mechanisms
// here behind the same BOOKING_STRATEGY flag.
const strategies: Record<string, Strategy> = {
  naive: bookSeatNaive,
};

function resolveStrategy(): Strategy {
  const strategy = strategies[config.bookingStrategy];
  if (!strategy) {
    throw new Error(
      `Unknown BOOKING_STRATEGY "${config.bookingStrategy}". Available: ${Object.keys(strategies).join(", ")}`,
    );
  }
  return strategy;
}

export const bookSeat: Strategy = (input) => resolveStrategy()(input);
