import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ context: null as unknown, error: null as Error | null }));
vi.mock("@vayada/backend-auth", async (original) => ({
  ...(await original<typeof import("@vayada/backend-auth")>()),
  requireAuthContext: vi.fn(() => {
    if (auth.error) throw auth.error;
    return auth.context;
  }),
}));

import { UnauthorizedError } from "@vayada/backend-auth";

import {
  createShortLinkRateLimit,
  type ShortLinkResolution,
} from "../domains/googleMapsShortLinks.js";
import { registerGoogleMapsLinksRoutes } from "./googleMapsLinks.js";

const LONG = "https://www.google.com/maps/place/6.03,80.21/data=!3d6.0275!4d80.2172";

function context(
  overrides: { kind?: string; membershipStatus?: string; actorStatus?: string } = {},
) {
  return {
    actor: { internalUserId: "user-1", status: overrides.actorStatus ?? "active" },
    selectedOrganization: {
      organizationId: "org-1",
      kind: overrides.kind ?? "hotel_group",
      status: "active",
    },
    membership: {
      membershipId: "m-1",
      roleKey: "hotel_owner",
      status: overrides.membershipStatus ?? "active",
    },
  };
}

async function call(
  payload: unknown,
  resolve: (url: unknown) => Promise<ShortLinkResolution> = async () => ({ ok: true, url: LONG }),
  limit = 20,
) {
  const app = Fastify();
  await registerGoogleMapsLinksRoutes(app, {
    resolve,
    rateLimit: createShortLinkRateLimit({ now: () => 0, limit }),
  });
  const response = await app.inject({
    method: "POST",
    url: "/resolve",
    payload: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
  await app.close();
  return response;
}

beforeEach(() => {
  auth.context = context();
  auth.error = null;
});

describe("POST /api/maps-links/resolve (VAY-2444)", () => {
  it("answers a signed-in hotel account member with the long link", async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, url: LONG }));
    const response = await call({ url: "https://maps.app.goo.gl/abc" }, resolve);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: LONG });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(resolve).toHaveBeenCalledWith("https://maps.app.goo.gl/abc");
  });

  it("refuses signed-out people and anyone outside an active hotel account", async () => {
    const resolve = vi.fn();
    auth.error = new UnauthorizedError("no session");
    expect((await call({ url: "x" }, resolve)).statusCode).toBe(401);
    auth.error = null;
    for (const overrides of [
      { kind: "platform" },
      { membershipStatus: "suspended" },
      { actorStatus: "disabled" },
    ]) {
      auth.context = context(overrides);
      const response = await call({ url: "x" }, resolve);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "forbidden" });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("maps each failure to its status", async () => {
    for (const [code, status] of [
      ["not_a_short_link", 422],
      ["unresolved", 404],
      ["unavailable", 503],
    ] as const) {
      const response = await call({ url: "x" }, async () => ({ ok: false, code }));
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ code });
    }
  });

  it("limits each person to its share of resolutions", async () => {
    const response = await call({ url: "https://maps.app.goo.gl/abc" }, undefined, 0);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ code: "rate_limited" });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  });
});
