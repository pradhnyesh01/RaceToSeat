// `retries` counts internal retry attempts a mechanism made before reaching
// this result. Optional and near-universally 0 today: naive, unique_constraint,
// pessimistic, and advisory never retry, so they simply omit it (the route
// layer defaults a missing value to 0 for the X-Booking-Retries header).
// retry_exhausted (ADR-0012) is the one kind where it's always meaningful, so
// it's required there.
export type BookSeatResult =
  | { kind: "created"; bookingId: string; createdAt: Date; retries?: number }
  | { kind: "idempotent_replay"; bookingId: string; createdAt: Date; retries?: number }
  | { kind: "conflict"; retries?: number }
  | { kind: "not_found"; retries?: number }
  | { kind: "retry_exhausted"; retries: number };

export interface BookSeatInput {
  seatIds: string[];
  userId: string;
  idempotencyKey: string;
}
