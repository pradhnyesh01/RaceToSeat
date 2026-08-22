import { config } from "../config.js";
import { bookSeatNaive } from "./naive.js";
import { bookSeatPessimistic } from "./pessimistic.js";
import type { BookSeatInput, BookSeatResult } from "./types.js";
import { bookSeatUniqueConstraint } from "./uniqueConstraint.js";

export type { BookSeatInput, BookSeatResult };

type Strategy = (input: BookSeatInput) => Promise<BookSeatResult>;

// Strategy is selected once at process startup (ADR-0002), not per request.
// Phase 0 shipped only "naive"; Phase 1+ add the remaining mechanisms here
// behind the same BOOKING_STRATEGY flag.
const strategies: Record<string, Strategy> = {
  naive: bookSeatNaive,
  unique_constraint: bookSeatUniqueConstraint,
  pessimistic: bookSeatPessimistic,
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
