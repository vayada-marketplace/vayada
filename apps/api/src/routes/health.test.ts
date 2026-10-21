import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerHealthRoutes } from "./health.js";

const checks = (liveness: boolean, readiness: boolean) => ({
  liveness: async () => liveness,
  readiness: async () => readiness,
});

describe("health routes", () => {
  it.each([
    ["/health", "ok"],
    ["/ready", "ready"],
  ])("serves %s while PostgreSQL answers", async (url, status) => {
    const app = Fastify();
    await app.register(registerHealthRoutes, { databaseHealth: checks(true, true) });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "vayada-api", status });
    await app.close();
  });

  it.each(["/health", "/ready"])(
    "returns 503 from %s while PostgreSQL is unavailable",
    async (url) => {
      const app = Fastify();
      await app.register(registerHealthRoutes, { databaseHealth: checks(false, false) });
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        service: "vayada-api",
        status: "unavailable",
        database: "unavailable",
      });
      await app.close();
    },
  );

  it("keeps /health alive while a shared pool has stopped serving; only /ready fails (VAY-2247 incident)", async () => {
    const app = Fastify();
    await app.register(registerHealthRoutes, { databaseHealth: checks(true, false) });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
    await app.close();
  });

  it("answers with the last result when a check doesn't settle in time", async () => {
    const stuck = () => new Promise<boolean>(() => undefined);
    let next: () => Promise<boolean> = stuck;
    const app = Fastify();
    await app.register(registerHealthRoutes, {
      databaseHealth: { liveness: () => next(), readiness: () => next() },
      answerWithinMs: 20,
    });
    // Before any result, a stuck check answers healthy.
    const started = Date.now();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    // After a failed check, a stuck one keeps answering 503 quickly.
    next = async () => false;
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);
    next = stuck;
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);
    // A check that throws counts as down.
    next = async () => {
      throw new Error("probe failed");
    };
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
    await app.close();
  });
});
