export type BookSeatResult =
  | { kind: "created"; bookingId: string; createdAt: Date }
  | { kind: "idempotent_replay"; bookingId: string; createdAt: Date }
  | { kind: "conflict" }
  | { kind: "not_found" };

export interface BookSeatInput {
  seatId: string;
  userId: string;
  idempotencyKey: string;
}
