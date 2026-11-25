// Cost of the reaper's sweep statement, before and after R7 (issue #57, ADR-0029).
// Not part of the matrix: run by hand with
//   npx tsx load-harness/chaos/bench-reaper-sweep.ts [--seats 20000] [--multi-seat-share 0.25] [--reps 5]
// On a throwaway database it seeds N expired `held` seats (a share of them in
// 2-seat Holds, the rest single-seat) and times one full sweep of the old
// statement (a plain UPDATE, kept below verbatim as the baseline) against the
// new one (`runReaperSweep`: FOR UPDATE SKIP LOCKED candidates + the
// whole-Hold guard), re-seeding between reps. The statement-level cost is all
// R7 can change for the no-Fault, nothing-locked case; this is the "does the
// fix make an ordinary tick slower" check.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runReaperSweep } from "../../src/reaper.js";
import { createScratchDb } from "./scratchDb.js";

const OLD_SWEEP = `WITH expired AS (
       UPDATE seats
       SET status = 'available', booked_by = NULL, held_until = NULL, version = version + 1
       WHERE status = 'held' AND held_until < now()
       RETURNING id
     ),
     deleted_hold_seats AS (
       DELETE FROM hold_seats WHERE seat_id IN (SELECT id FROM expired) RETURNING hold_id
     )
     DELETE FROM holds WHERE id IN (SELECT hold_id FROM deleted_hold_seats)`;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

async function seed(db: Pool, eventId: string, n: number, multiShare: number): Promise<void> {
  await db.query("DELETE FROM hold_seats");
  await db.query("DELETE FROM holds");
  await db.query("DELETE FROM seats WHERE event_id = $1", [eventId]);
  await db.query("INSERT INTO seats (event_id, label) SELECT $1, 's' || g FROM generate_series(1, $2) g", [eventId, n]);
  const seats = (await db.query<{ id: string }>("SELECT id FROM seats WHERE event_id = $1 ORDER BY label", [eventId])).rows.map((r) => r.id);
  const groups: string[][] = [];
  for (let i = 0; i < seats.length; ) {
    const size = Math.random() < multiShare && i + 1 < seats.length ? 2 : 1;
    groups.push(seats.slice(i, i + size));
    i += size;
  }
  const holdIds = groups.map(() => randomUUID());
  await db.query(
    "INSERT INTO holds (id, idempotency_key) SELECT h, 'k-' || h FROM unnest($1::uuid[]) h",
    [holdIds],
  );
  const flat = groups.flatMap((g, i) => g.map((s) => [holdIds[i]!, s] as const));
  await db.query("INSERT INTO hold_seats (hold_id, seat_id) SELECT * FROM unnest($1::uuid[], $2::uuid[])", [flat.map((f) => f[0]), flat.map((f) => f[1])]);
  await db.query("UPDATE seats SET status = 'held', held_until = now() - interval '1 second', booked_by = 'u' WHERE event_id = $1", [eventId]);
  // Fresh bulk loads have no planner statistics; a running server does (autovacuum).
  await db.query("ANALYZE seats");
  await db.query("ANALYZE holds");
  await db.query("ANALYZE hold_seats");
}

const n = arg("--seats", 20000);
const multi = arg("--multi-seat-share", 0.25);
const reps = arg("--reps", 5);
const scratch = await createScratchDb(process.env.DATABASE_URL!, []);
try {
  const db = scratch.pool;
  const eventId = (await db.query<{ id: string }>("INSERT INTO events (name) VALUES ('bench') RETURNING id")).rows[0]!.id;
  const times: Record<string, number[]> = { old: [], new: [] };
  for (let rep = 0; rep < reps; rep++) {
    // Alternate which statement runs first so neither always gets a cold or a warm cache.
    for (const which of rep % 2 === 0 ? (["old", "new"] as const) : (["new", "old"] as const)) {
      await seed(db, eventId, n, multi);
      const t0 = performance.now();
      if (which === "old") await db.query(OLD_SWEEP);
      else await runReaperSweep(db);
      times[which]!.push(performance.now() - t0);
      const left = (await db.query("SELECT (SELECT count(*) FROM seats WHERE event_id=$1 AND status='held')::int AS held, (SELECT count(*) FROM holds)::int AS holds, (SELECT count(*) FROM hold_seats)::int AS hs", [eventId])).rows[0];
      if (left.held !== 0 || left.holds !== 0 || left.hs !== 0) throw new Error(`${which} sweep left state behind: ${JSON.stringify(left)}`);
    }
  }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  console.log(`${n} expired seats (${Math.round(multi * 100)}% of Holds are 2-seat), ${reps} reps each, one full sweep:`);
  for (const k of ["old", "new"]) console.log(`  ${k.padEnd(3)}: median ${med(times[k]!).toFixed(0)} ms  (${times[k]!.map((x) => x.toFixed(0)).join(", ")})`);
} finally {
  await scratch.drop();
}
