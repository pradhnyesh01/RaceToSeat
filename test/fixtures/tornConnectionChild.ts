// Child-process half of test/db/tornConnection.test.ts (issue #53, R1).
//
// Has to be its own process: the failure under test is an *uncaught
// exception that ends the process*, which would otherwise be reported (or
// swallowed) by Vitest's own handlers instead of observed as an exit code.
// Runs a real booking whose checked-out connection is terminated
// mid-transaction, then proves the process and the pool both kept serving.
//
// argv: <victimSeatId> <otherSeatId>. DATABASE_URL must carry
// application_name=r1-victim so the victim's backend can be found.
import { Client } from "pg";
import { config } from "../../src/config.js";
import { pool } from "../../src/db/pool.js";
import { bookSeatNaive } from "../../src/strategies/naive.js";

const [victimSeatId, otherSeatId] = process.argv.slice(2) as [string, string];

function plainUrl(): string {
  const url = new URL(config.databaseUrl);
  url.searchParams.delete("application_name");
  return url.toString();
}

async function main(): Promise<void> {
  // Blocker: an uncommitted write on the victim seat's row, so the victim
  // booking's own `UPDATE seats ...` waits on it — a request that is
  // genuinely mid-transaction on a checked-out connection when it is cut.
  const blocker = new Client({ connectionString: plainUrl() });
  await blocker.connect();
  await blocker.query("BEGIN");
  await blocker.query("UPDATE seats SET version = version WHERE id = $1", [victimSeatId]);

  const victim = bookSeatNaive({ seatIds: [victimSeatId], userId: "victim", idempotencyKey: "r1-victim-key" }).then(
    (result) => ({ settled: "resolved" as const, result }),
    (err: unknown) => ({ settled: "rejected" as const, message: err instanceof Error ? err.message : String(err) }),
  );

  // Wait until the victim's backend is blocked on the lock, then terminate it.
  const killer = new Client({ connectionString: plainUrl() });
  await killer.connect();
  let killed = 0;
  for (let i = 0; i < 100 && killed === 0; i++) {
    const res = await killer.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE application_name = 'r1-victim' AND wait_event_type = 'Lock'`,
    );
    killed = res.rowCount ?? 0;
    if (killed === 0) await new Promise((r) => setTimeout(r, 20));
  }
  if (killed === 0) throw new Error("never found the victim's blocked backend to terminate");

  const victimOutcome = await victim;
  // Give an unhandled 'error' event time to surface if it was going to.
  await new Promise((r) => setTimeout(r, 200));

  await blocker.query("ROLLBACK");
  await blocker.end();
  await killer.end();

  // The process and the pool must both still serve other requests.
  const other = await bookSeatNaive({ seatIds: [otherSeatId], userId: "survivor", idempotencyKey: "r1-survivor-key" });
  await pool.end();
  console.log(JSON.stringify({ killed, victimOutcome, otherKind: other.kind }));
}

main().catch((err) => {
  console.error("child failed:", err);
  process.exit(2);
});
