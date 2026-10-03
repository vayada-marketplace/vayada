import { describe, expect, it } from "vitest";
import { loadHotelSetupCommandForwarder } from "./hotelSetupCommandForwarder.js";
import Fastify from "fastify";
import { vi } from "vitest";

const token = "internal-token-with-at-least-32-bytes";
describe("launch settings transport", () => {
  it("uses only the fixed property destination and original bearer, without fallback", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ defaultCurrency: "LKR" }), { status: 200 }));
    const forward = loadHotelSetupCommandForwarder(
      {
        HOTEL_SETUP_COMMAND_ORIGIN: "https://property-setup.internal",
        HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
      },
      transport,
    )!;
    const app = Fastify();
    const propertyId = "10000000-0000-4000-8000-000000000001";
    app.all("/save", (request, reply) => forward(request, reply, propertyId, "launch_settings"));
    try {
      const request = {
        method: "PUT" as const,
        url: "/save",
        headers: { authorization: "Bearer original-session", "x-hotel-id": "injected" },
        payload: { defaultCurrency: "LKR" },
      };
      expect((await app.inject(request)).statusCode).toBe(200);
      const [url, init] = transport.mock.calls[0]!;
      expect(String(url)).toBe(
        `https://property-setup.internal/properties/${propertyId}/launch-settings`,
      );
      expect(init).toMatchObject({
        method: "PUT",
        redirect: "error",
        headers: {
          authorization: "Bearer original-session",
          "x-vayada-internal-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify(request.payload),
      });
      expect(Object.keys(init!.headers!)).toHaveLength(3);
      transport.mockClear();
      expect((await app.inject({ ...request, method: "POST" })).statusCode).toBe(400);
      expect((await app.inject({ ...request, url: "/save?destination=other" })).statusCode).toBe(
        400,
      );
      expect((await app.inject({ ...request, headers: {} })).statusCode).toBe(401);
      expect(transport).not.toHaveBeenCalled();
      transport.mockRejectedValueOnce(new Error("unavailable"));
      expect((await app.inject(request)).json()).toEqual({ code: "hotel_setup_unavailable" });
    } finally {
      await app.close();
    }
  });
});
describe("private setup forwarding configuration", () => {
  it("stays disabled without configuration", () => {
    expect(loadHotelSetupCommandForwarder({})).toBeUndefined();
  });
  it.each([
    { HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal" },
    { HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal/path",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://user:password@setup.internal",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal?redirect=x",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal#fragment",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "http://setup.internal",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: "short",
    },
  ])("rejects partial or unsafe configuration", (env) => {
    expect(() => loadHotelSetupCommandForwarder(env)).toThrow();
  });
  it("allows isolated loopback testing without changing production defaults", () => {
    expect(
      loadHotelSetupCommandForwarder({
        HOTEL_SETUP_COMMAND_ORIGIN: "http://127.0.0.1:8005",
        HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
      }),
    ).toBeTypeOf("function");
  });
});

describe("private setup admission hold", () => {
  it.each(["currency", "modules", "financials", "property_creation", "launch_settings"] as const)(
    "blocks %s without selecting transport or the ordinary writer",
    async (operation) => {
      const transport = vi.fn<typeof fetch>();
      const forward = loadHotelSetupCommandForwarder(
        { HOTEL_SETUP_COMMAND_ADMISSION: "blocked" },
        transport,
      )!;
      const app = Fastify();
      app.all("/hold", (request, reply) => forward(request, reply, null, operation));
      try {
        const response = await app.inject({ method: "POST", url: "/hold" });
        expect(response.statusCode).toBe(503);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual({ code: "hotel_setup_unavailable" });
        expect(transport).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it("requires private forwarding when admission is enabled and rejects unknown states", () => {
    expect(() =>
      loadHotelSetupCommandForwarder({ HOTEL_SETUP_COMMAND_ADMISSION: "enabled" }),
    ).toThrow();
    expect(() =>
      loadHotelSetupCommandForwarder({ HOTEL_SETUP_COMMAND_ADMISSION: "allow" }),
    ).toThrow();
    expect(
      loadHotelSetupCommandForwarder({
        HOTEL_SETUP_COMMAND_ADMISSION: "enabled",
        HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal",
        HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
      }),
    ).toBeTypeOf("function");
  });
});
