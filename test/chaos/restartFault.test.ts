// The C4 Fault's safety rails and bookkeeping (issue #51), without Docker.
// The destructive part is a database-server restart, so the properties pinned
// here are the ones that stop it hitting the wrong container.
import { describe, expect, it } from "vitest";
import {
  CONTAINER_NAME_PREFIX,
  dockerRunArgs,
  ownershipProblem,
  postgresFlags,
  RUN_LABEL_KEY,
} from "../../load-harness/chaos/restartFault.js";
import { recoveryMetrics, tallyWindows } from "../../load-harness/chaos/runRestart.js";
import type { RequestEvent } from "../../load-harness/chaos/restartLoad.js";

const mine = { id: "a".repeat(64), name: `${CONTAINER_NAME_PREFIX}1234abcd`, runTag: "1234abcd" };

describe("ownership guard", () => {
  it("accepts the container this run created", () => {
    expect(ownershipProblem(mine, { id: mine.id, name: `/${mine.name}`, label: "1234abcd" })).toBeUndefined();
  });

  it("refuses the repo's dev database and any other container", () => {
    expect(ownershipProblem(mine, { id: "b".repeat(64), name: "/racetoseat-postgres", label: "" })).toMatch(/not this run's/);
  });

  it("refuses a recycled name (same name, different container id)", () => {
    expect(ownershipProblem(mine, { id: "c".repeat(64), name: `/${mine.name}`, label: "1234abcd" })).toMatch(/id/);
  });

  it("refuses a matching id whose label was changed", () => {
    expect(ownershipProblem(mine, { id: mine.id, name: `/${mine.name}`, label: "someone-else" })).toMatch(/label/);
  });

  it("refuses to act on anything not named c4-pg-*, even if its own id matches", () => {
    expect(ownershipProblem({ ...mine, name: "racetoseat-postgres" }, { id: mine.id, name: "/racetoseat-postgres", label: "1234abcd" })).toMatch(/does not start with/);
  });
});

describe("docker run arguments", () => {
  const args = dockerRunArgs({ containerName: mine.name, runTag: mine.runTag, hostPort: 54321, image: "postgres:17", profile: "safe", user: "u", password: "p", database: "d" });

  it("publishes on loopback only, with a generated name and the run label", () => {
    expect(args).toContain("127.0.0.1:54321:5432");
    expect(args).toContain(mine.name);
    expect(args).toContain(`${RUN_LABEL_KEY}=${mine.runTag}`);
    expect(args.join(" ")).not.toMatch(/racetoseat-postgres|-v |--volume|--network|--restart/);
  });

  it("the safe profile adds no durability setting; the unsafe one weakens exactly the commit path", () => {
    const safe = postgresFlags("safe").join(" ");
    expect(safe).not.toMatch(/synchronous_commit|fsync|wal_writer/);
    const unsafe = postgresFlags("unsafe").join(" ");
    expect(unsafe).toContain("synchronous_commit=off");
    expect(unsafe).toContain("wal_writer_delay=10000ms");
  });
});

const ev = (status: number, sentAtMs: number, doneAtMs: number, error?: string): RequestEvent => ({ op: "book", key: "k", attempt: 0, sentAtMs, doneAtMs, status, error });

describe("timeline bookkeeping", () => {
  const timeline = { variant: "kill" as const, profile: "safe" as const, commandStartedAtMs: 1000, commandReturnedAtMs: 4000, heldDownMs: 3000, firstProbeFailedAtMs: 1050, dbBackAtMs: 4100, unreachableMs: 3050 };

  it("splits attempts into before / during / after the outage by when they finished", () => {
    const t = tallyWindows([ev(201, 10, 20), ev(502, 1100, 1110), ev(0, 1200, 1900, "ECONNREFUSED"), ev(201, 4200, 4210)], 1000, 4100);
    expect(t.before).toEqual({ "201": 1 });
    expect(t.during).toEqual({ "502": 1, "none:ECONNREFUSED": 1 });
    expect(t.after).toEqual({ "201": 1 });
  });

  it("measures the write outage from the last 201 before the Fault to the first after recovery", () => {
    const m = recoveryMetrics([ev(201, 900, 950), ev(201, 980, 990), ev(502, 1100, 1110), ev(201, 4150, 4300)], timeline);
    expect(m.lastCreatedBeforeFaultMs).toBe(990);
    expect(m.firstCreatedAfterDbBackMs).toBe(4300);
    expect(m.writeOutageMs).toBe(3310);
    expect(m.appLagAfterDbBackMs).toBe(200);
    expect(m.firstFailureAfterFaultMs).toBe(110);
  });

  it("reports nothing when no Fault ran or the server never came back", () => {
    expect(recoveryMetrics([ev(201, 1, 2)], undefined).writeOutageMs).toBeNull();
    expect(recoveryMetrics([ev(201, 1, 2)], { ...timeline, dbBackAtMs: null }).writeOutageMs).toBeNull();
  });
});
