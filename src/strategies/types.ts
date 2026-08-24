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

// Hold has no retry_exhausted kind and no `retries` field at all: unlike
// booking, hold-acquisition is pessimistic-only (ADR-0017) and never wraps
// withDeadlockRetry (sorted seat_ids alone is enough — NOWAIT can't deadlock,
// ADR-0006), so there is no retry count to ever report.
export type HoldSeatsResult =
  | { kind: "created"; holdId: string; seatIds: string[]; heldUntil: Date }
  | { kind: "idempotent_replay"; holdId: string; seatIds: string[]; heldUntil: Date }
  | { kind: "conflict" }
  | { kind: "not_found" };

export interface HoldSeatsInput {
  seatIds: string[];
  userId: string;
  idempotencyKey: string;
}
