import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerHealthRoutes } from "./health.js";

describe("health routes", () => {
  it.each([
    ["/health", "ok"],
    ["/ready", "ready"],
  ])("serves %s while PostgreSQL answers", async (url, status) => {
    const app = Fastify();
    await app.register(registerHealthRoutes, { databaseHealth: async () => true });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "vayada-api", status });
    await app.close();
  });

  it.each(["/health", "/ready"])(
    "returns 503 from %s while PostgreSQL is unavailable",
    async (url) => {
      const app = Fastify();
      await app.register(registerHealthRoutes, { databaseHealth: async () => false });
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
});
