import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerRouteGroupHealthRoutes } from "./index.js";

describe("backend-http", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("registers selected route group health routes", async () => {
    await app.register(registerRouteGroupHealthRoutes, {
      groups: ["booking"],
      prefix: "/api",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      group: "booking",
      status: "ok",
    });
  });
});
