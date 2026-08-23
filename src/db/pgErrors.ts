function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === code;
}

export function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    hasPgErrorCode(err, "23505") &&
    "constraint" in (err as object) &&
    (err as { constraint?: string }).constraint === constraint
  );
}

// Raised by SELECT ... FOR UPDATE NOWAIT when the row is already locked
// (ADR-0006: the pessimistic strategy never blocks waiting for a lock).
export function isLockNotAvailable(err: unknown): boolean {
  return hasPgErrorCode(err, "55P03");
}

// Raised when a UUID-typed column is compared against a malformed string.
export function isInvalidTextRepresentation(err: unknown): boolean {
  return hasPgErrorCode(err, "22P02");
}

// Raised on COMMIT (or occasionally an earlier statement) when a SERIALIZABLE
// transaction can't be serialized against concurrent transactions (ADR-0011)
// — the trigger for withSerializableTransaction's retry loop.
export function isSerializationFailure(err: unknown): boolean {
  return hasPgErrorCode(err, "40001");
}
