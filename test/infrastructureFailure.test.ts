// Issue #55 (finding R3), half 2: what a client sees when the database is
// unreachable (ADR-0025). No database needed: the app's error handler is
// driven through a route that throws.
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { isInfrastructureFailure } from "../src/db/pgErrors.js";

describe("isInfrastructureFailure", () => {
  it.each([
    ["pg: connection torn mid-query", new Error("Connection terminated unexpectedly")],
    ["pg: a client that already errored", new Error("Client has encountered a connection error and is not queryable")],
    ["pg: a client that was closed", new Error("Client was closed and is not queryable")],
    ["node: connection reset", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["node: connection refused", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["node: broken pipe", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })],
    ["pg: backend terminated (pg_terminate_backend)", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })],
    ["pg: crash shutdown", Object.assign(new Error("the database system is in recovery mode"), { code: "57P02" })],
    ["pg: cannot connect now (starting up)", Object.assign(new Error("the database system is starting up"), { code: "57P03" })],
    ["pg: connection exception class", Object.assign(new Error("connection failure"), { code: "08006" })],
    ["pg: too many connections", Object.assign(new Error("sorry, too many clients already"), { code: "53300" })],
    ["wrapped: infrastructure error as `cause`", new Error("wrapper", { cause: new Error("Connection terminated unexpectedly") })],
  ])("is true for %s", (_name, err) => {
    expect(isInfrastructureFailure(err)).toBe(true);
  });

  it.each([
    ["a unique violation", Object.assign(new Error("duplicate key"), { code: "23505" })],
    ["a lock-not-available", Object.assign(new Error("could not obtain lock"), { code: "55P03" })],
    ["a deadlock abort", Object.assign(new Error("deadlock detected"), { code: "40P01" })],
    ["a serialization failure", Object.assign(new Error("could not serialize"), { code: "40001" })],
    ["a plain bug", new TypeError("x is not a function")],
    ["a non-error", "boom"],
    ["null", null],
  ])("is false for %s", (_name, err) => {
    expect(isInfrastructureFailure(err)).toBe(false);
  });
});

describe("the global error handler", () => {
  async function respondTo(err: unknown) {
    const app = createApp();
    app.get("/__boom", async () => {
      throw err;
    });
    const res = await app.inject({ method: "GET", url: "/__boom" });
    await app.close();
    return res;
  }

  it("answers an infrastructure failure with a distinct, retriable 502 — not a bare 500", async () => {
    const res = await respondTo(new Error("Connection terminated unexpectedly"));

    expect(res.statusCode).toBe(502);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.json()).toMatchObject({ outcome: "infrastructure_failure" });
  });

  it("keeps a genuinely unexpected error a 500", async () => {
    const res = await respondTo(new TypeError("x is not a function"));

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal server error" });
  });

  it("never reuses 503, which stays retry_exhausted's alone (ADR-0012/0015)", async () => {
    const res = await respondTo(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));

    expect(res.statusCode).not.toBe(503);
    expect(res.headers["x-booking-retries"]).toBeUndefined();
  });
});
