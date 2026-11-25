export interface SeatClaimBody {
  seatIds: string[];
  userId: string;
  idempotencyKey: string;
}

// Shared request-body validation for POST /bookings and POST /holds: both
// claim one or more seats atomically for one user under a client-supplied
// idempotency_key, so the required-fields check and the case-insensitive
// duplicate-seat_ids check (seat ids are UUIDs, which Postgres compares
// case-insensitively — every strategy's WHERE id = ANY($1) would otherwise
// silently collapse two differently-cased spellings of the same seat into
// one row) are identical between them.
export function validateSeatClaimBody(body: unknown): { ok: true; value: SeatClaimBody } | { ok: false; error: string } {
  const b = body as { seat_ids?: unknown; user_id?: unknown; idempotency_key?: unknown } | null | undefined;

  if (
    !Array.isArray(b?.seat_ids) ||
    b.seat_ids.length === 0 ||
    !b.seat_ids.every((seatId): seatId is string => typeof seatId === "string") ||
    typeof b?.user_id !== "string" ||
    typeof b?.idempotency_key !== "string"
  ) {
    return {
      ok: false,
      error: "seat_ids (a non-empty array of strings), user_id, and idempotency_key are all required",
    };
  }

  if (new Set(b.seat_ids.map((seatId) => seatId.toLowerCase())).size !== b.seat_ids.length) {
    return { ok: false, error: "seat_ids must not contain duplicates" };
  }

  return { ok: true, value: { seatIds: b.seat_ids, userId: b.user_id, idempotencyKey: b.idempotency_key } };
}
