import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

describe("vayada-api", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns health status without binding a port", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "vayada-api",
      status: "ok",
    });
  });

  it("registers product route group placeholders", async () => {
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
