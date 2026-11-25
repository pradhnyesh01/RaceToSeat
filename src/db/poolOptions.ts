import type { PoolConfig } from "pg";
import { config } from "../config.js";

// The connection options for the app's pg Pool, including every database bound
// from issue #56 (finding R4, ADR-0026) in one place so the set of bounds - and
// which side of the wire enforces each - can be read at a glance.
//
//   server side (startup parameters, applied to every connection):
//     statement_timeout                     a statement, including a wait for a row lock
//     idle_in_transaction_session_timeout   an open transaction with nothing running
//   client side:
//     query_timeout            any one statement's answer; the only bound that works when
//                              the network drops bytes silently (a partition). Paired with
//                              destroyConnectionOnQueryTimeout (queryDeadline.ts): pg alone
//                              rejects the query but leaves the connection waiting.
//     connectionTimeoutMillis  opening a connection, or waiting for a free slot in the pool
//
// Not set, on purpose: lock_timeout (raises 55P03, which NOWAIT already uses and the
// strategies translate to 409; statement_timeout bounds a lock wait anyway), and TCP
// keepalive (a proxy or a stalled path still ACKs probes, and query_timeout already bounds
// every statement).
export function poolOptions(): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    statement_timeout: config.dbStatementTimeoutMs,
    idle_in_transaction_session_timeout: config.dbIdleInTransactionTimeoutMs,
    query_timeout: config.dbQueryTimeoutMs,
    connectionTimeoutMillis: config.dbConnectTimeoutMs,
  };
}
