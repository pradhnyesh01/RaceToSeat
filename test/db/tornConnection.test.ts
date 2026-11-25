import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { resetDb, seedEventWithSeats } from "../testDb.js";

// Issue #53 (finding R1): pg-pool removes its own 'error' listener from a
// client while a request has it checked out, so a connection torn mid-request
// (pg_terminate_backend, TCP reset, proxy teardown) emitted an unhandled
// 'error' event and ended the whole process. `pool.on("error")` alone cannot
// cover that path. The torn connection must fail only the request that owned
// it.
//
// Runs in a child process because the failure being guarded against is the
// process exiting — under Vitest itself that would surface as an unhandled
// error attributed to the runner rather than as an exit code we can assert on.

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runChild(args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    databaseUrl.searchParams.set("application_name", "r1-victim");
    const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/tornConnectionChild.ts", ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("a torn checked-out connection (R1)", () => {
  beforeEach(resetDb);

  it("fails only the request that owned it, and the process keeps serving", async () => {
    const { seatIdsByLabel } = await seedEventWithSeats(["A1", "A2"]);
    const victimSeat = seatIdsByLabel["A1"]!;
    const otherSeat = seatIdsByLabel["A2"]!;

    const { code, stdout, stderr } = await runChild([victimSeat, otherSeat]);

    expect(stderr).not.toMatch(/Unhandled 'error' event/);
    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").pop()!) as {
      killed: number;
      victimOutcome: { settled: string };
      otherKind: string;
    };
    expect(result.killed).toBe(1);
    // Never a success: the cut request must reject through the normal error path.
    expect(result.victimOutcome.settled).toBe("rejected");
    expect(result.otherKind).toBe("created");

    // Ground truth: nothing was booked for the cut request's seat.
    const booked = await pool.query("SELECT 1 FROM booking_seats WHERE seat_id = $1", [victimSeat]);
    expect(booked.rowCount).toBe(0);
  }, 30_000);
});
