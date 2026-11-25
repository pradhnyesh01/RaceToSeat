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

// Raised when Postgres's deadlock detector aborts one side of a wait-for
// cycle between two transactions holding row locks in opposite order
// (ADR-0014) — the trigger for withDeadlockRetry's retry loop, and for
// withSerializableTransaction's extended one.
export function isDeadlockDetected(err: unknown): boolean {
  return hasPgErrorCode(err, "40P01");
}

// SQLSTATEs that mean "the database could not be reached or has gone away",
// as opposed to "the database understood this request and refused it": class
// 08 (connection exception), 57P01-57P03 (admin shutdown — what
// pg_terminate_backend produces — crash shutdown, cannot connect now), and
// 53300 (too many connections).
const INFRASTRUCTURE_SQLSTATES = new Set(["57P01", "57P02", "57P03", "53300"]);

// Node socket errors a torn or refused connection surfaces as.
const INFRASTRUCTURE_ERRNOS = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
]);

// pg reports some connection failures with a message and no code at all.
const INFRASTRUCTURE_MESSAGES = [
  "Connection terminated",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
];

// True when `err` (or anything in its `cause` chain) says the database
// connection failed, rather than the database rejecting the request (ADR-0025).
// The global error handler uses this to answer a distinct, retriable outcome
// instead of a bare 500; nothing here changes how any designed outcome
// (conflict, not found, retry exhausted) is reached.
export function isInfrastructureFailure(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === "string" && (INFRASTRUCTURE_SQLSTATES.has(code) || code.startsWith("08") || INFRASTRUCTURE_ERRNOS.has(code))) {
      return true;
    }
    if (typeof message === "string" && INFRASTRUCTURE_MESSAGES.some((m) => message.startsWith(m))) {
      return true;
    }
    current = cause;
  }
  return false;
}
