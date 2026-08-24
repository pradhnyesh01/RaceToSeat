// `retries` counts internal retry attempts a mechanism made before reaching
// this result. Optional and near-universally 0 today: pessimistic and
// advisory never retry, so they simply omit it (the route layer defaults a
// missing value to 0 for the X-Booking-Retries header). naive and
// unique_constraint can retry too (issue #26/#27's withDeadlockRetry,
// ADR-0014) but only for a multi-seat deadlock abort — a single-seat request
// to either never retries. retry_exhausted (ADR-0012) is the one kind where
// it's always meaningful, so it's required there.
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
