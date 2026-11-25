// Regression test for issue #54 (finding R2): killing every idle pooled
// backend must not end the process, and the next request must be served on a
// fresh connection. Before the fix the pool emitted 'error' with no listener
// and Node exited with "Emitted 'error' event on BoundPool instance".
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("idle pooled connection killed (R2)", () => {
  it("does not exit the process, and the next request is served", () => {
    const run = spawnSync("npx", ["tsx", "test/fixtures/idlePoolKillProbe.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PGAPPNAME: `r2-idle-probe-${randomUUID()}` },
      timeout: 30_000,
    });
    const why = `exit ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`;
    expect(run.stderr, why).not.toContain("Emitted 'error' event");
    expect(run.stdout, why).toContain("SURVIVED");
    expect(run.status, why).toBe(0);
    expect(run.stdout, why).toContain("KILLED 5");
  }, 40_000);
});
