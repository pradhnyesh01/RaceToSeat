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
//
// 55P03 is ALSO what a `lock_timeout` raises (issue #56, ADR-0026), and the code
// alone cannot tell the two apart. The app never sets lock_timeout - a blocked
// statement is bounded by statement_timeout (57014) instead - so in practice this
// is NOWAIT-only; the message check below is defence in depth for a lock_timeout
// an operator sets on the role or database, which must never be read as "another
// request holds this seat" (409). PostgreSQL's message text is stable but can be
// localised, so this is a backstop, not the primary mechanism.
export function isLockNotAvailable(err: unknown): boolean {
  return hasPgErrorCode(err, "55P03") && !isLockTimeout(err);
}

// A `lock_timeout` firing: 55P03 "canceling statement due to lock timeout".
export function isLockTimeout(err: unknown): boolean {
  return hasPgErrorCode(err, "55P03") && /lock timeout/i.test(errorMessage(err));
}

function errorMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
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

// SQLSTATEs a bound firing produces: 57014 (query_canceled: statement_timeout, or
// a user cancel), 25P03 (idle_in_transaction_session_timeout) and 25P04
// (transaction_timeout, PostgreSQL 17+).
const TIMEOUT_SQLSTATES = new Set(["57014", "25P03", "25P04"]);

// Messages of the client-side bounds, which carry no code: pg's `query_timeout`,
// pg-pool's `connectionTimeoutMillis` (waiting for a free slot / opening a
// connection) and pg's own connection-establishment timeout.
const TIMEOUT_MESSAGES = ["Query read timeout", "timeout exceeded when trying to connect", "Connection terminated due to connection timeout"];

// True when `err` (or anything in its `cause` chain) is one of the bounds from
// issue #56 firing - a timeout, as opposed to the database being unreachable
// (`isInfrastructureFailure`) or refusing the request (a conflict). The global
// error handler answers it with 504; it is checked before the infrastructure
// class because pg words its connect timeout "Connection terminated ...".
export function isTimeoutFailure(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === "string" && TIMEOUT_SQLSTATES.has(code)) {
      return true;
    }
    if (isLockTimeout(current)) {
      return true;
    }
    if (typeof message === "string" && TIMEOUT_MESSAGES.includes(message)) {
      return true;
    }
    current = cause;
  }
  return false;
}
