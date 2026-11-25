import type { PoolClient } from "pg";

// Issue #56 (finding R4, ADR-0026). pg's `query_timeout` rejects a query that has
// not been answered in time - and nothing else. It does not touch the connection,
// which is still waiting for the ReadyForQuery of the query it gave up on, so the
// next statement queues behind it forever. That next statement is the catch
// block's ROLLBACK, so without this a timed-out request would never answer and
// would hold its row locks for as long as the stall lasts - the exact failure the
// timeout exists to end.
//
// So when a query times out, the connection is destroyed: the queued ROLLBACK is
// rejected at once with "Connection terminated" (logged as secondary by
// rollbackAfterFailure, ADR-0025, never replacing the timeout), pg-pool discards
// the dead client on release, and the server - which sees the session vanish or,
// during a partition, idles it out - rolls back the transaction and frees its locks.
//
// Applied per connection from `pool.on("connect")`, so every way of getting a client
// out of the pool is covered, including pool.query() (the reaper), whose callback
// form is handled too.
export const QUERY_READ_TIMEOUT_MESSAGE = "Query read timeout";

type QueryFn = (...args: unknown[]) => unknown;

export function destroyConnectionOnQueryTimeout(client: PoolClient): void {
  const original = (client.query as unknown as QueryFn).bind(client);

  const destroyIfTimedOut = (err: unknown): void => {
    if (err instanceof Error && err.message === QUERY_READ_TIMEOUT_MESSAGE) {
      // `connection` is pg's own, undocumented-but-stable handle on the socket;
      // destroying the stream ends the client exactly as a network reset would.
      (client as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
    }
  };

  (client as unknown as { query: QueryFn }).query = (...args: unknown[]): unknown => {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = (err: unknown, result: unknown) => {
        destroyIfTimedOut(err);
        (last as QueryFn)(err, result);
      };
      return original(...args);
    }
    const result = original(...args);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      // Registered before the caller can attach its own handler, so the connection
      // is already doomed by the time the caller's catch block issues its ROLLBACK.
      (result as Promise<unknown>).catch(destroyIfTimedOut);
    }
    return result;
  };
}
