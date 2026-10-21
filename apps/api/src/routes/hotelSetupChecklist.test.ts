import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const policy = vi.hoisted(() => ({ context: null as unknown }));
vi.mock("./policy.js", () => ({ enforceRoutePolicy: vi.fn(() => policy.context) }));
vi.mock("@vayada/backend-authorization", async (original) => ({
  ...(await original<typeof import("@vayada/backend-authorization")>()),
  resolveEffectivePropertyAccess: vi.fn(async () => ({ propertyIds: [propertyId] })),
}));

import {
  parseChecklistAcknowledgement,
  parseChecklistViewerChange,
  registerHotelSetupChecklistRoutes,
  type HotelSetupChecklistRouteOptions,
} from "./hotelSetupChecklist.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const organizationId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
const userId = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";
const checklist = { contractVersion: "hotel-setup-checklist.v1", propertyId, phase: "live" };

function context(overrides: { kind?: string; sessionId?: string | null } = {}) {
  return {
    selectedOrganization: { organizationId, kind: overrides.kind ?? "hotel_group" },
    // A manager, not only the owner: the checklist is for anyone who may manage setup.
    membership: { roleKey: "hotel_manager" },
    actor: {
      internalUserId: userId,
      providerIdentity: {
        sessionId: overrides.sessionId === undefined ? "session-1" : overrides.sessionId,
      },
    },
    linkedResources: [],
    audit: { requestId: "req-1", receivedAt: "2026-10-20T09:00:00.000Z" },
  };
}

type Service = ReturnType<HotelSetupChecklistRouteOptions["createService"]>;

async function call(
  method: "GET" | "POST" | "PUT",
  path: string,
  service: Partial<Service>,
  payload?: unknown,
  id = propertyId,
) {
  const app = Fastify();
  await registerHotelSetupChecklistRoutes(app, {
    createService: () => service as Service,
    propertyAccessRepository: {} as never,
  });
  const response = await app.inject({
    method,
    url: `/properties/${id}/checklist${path}`,
    ...(payload === undefined
      ? {}
      : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
  });
  await app.close();
  return response;
}

const actor = {
  organizationId,
  propertyId,
  userId,
  requestId: "req-1",
  correlationId: null,
  requestedAt: "2026-10-20T09:00:00.000Z",
};

beforeEach(() => {
  policy.context = context();
});

describe("hotel setup checklist routes (VAY-2247 wave 2)", () => {
  it("GET returns the checklist for the signed-in person", async () => {
    const read = vi.fn(async () => checklist as never);
    const response = await call("GET", "", { read });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(checklist);
    expect(read).toHaveBeenCalledWith(actor);
  });

  it("GET says when the hotel isn't there", async () => {
    const response = await call("GET", "", { read: vi.fn(async () => null) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "property_not_found" });
  });

  it("POST acknowledgements records Looks good for calendar or guest terms", async () => {
    const acknowledge = vi.fn(async () => checklist as never);
    const response = await call("POST", "/acknowledgements", { acknowledge }, { item: "calendar" });
    expect(response.statusCode).toBe(200);
    expect(acknowledge).toHaveBeenCalledWith(actor, "calendar");
    for (const invalid of [{ item: "photos" }, { item: "calendar", extra: 1 }, {}, null])
      expect((await call("POST", "/acknowledgements", { acknowledge }, invalid)).statusCode).toBe(
        400,
      );
  });

  it("PUT viewer changes only the signed-in person's Hide for now and Dismiss", async () => {
    const setViewer = vi.fn(async () => checklist as never);
    const response = await call("PUT", "/viewer", { setViewer }, { hidden: true });
    expect(response.statusCode).toBe(200);
    expect(setViewer).toHaveBeenCalledWith(actor, { hidden: true });
    for (const invalid of [{}, { hidden: "yes" }, { hidden: true, other: true }])
      expect((await call("PUT", "/viewer", { setViewer }, invalid)).statusCode).toBe(400);
  });

  it("needs a signed-in session on a hotel group and a property in scope", async () => {
    const read = vi.fn();
    policy.context = context({ sessionId: null });
    expect((await call("GET", "", { read })).statusCode).toBe(403);
    policy.context = context({ kind: "creator" });
    expect((await call("GET", "", { read })).statusCode).toBe(403);
    policy.context = context();
    const other = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
    expect((await call("GET", "", { read }, undefined, other)).statusCode).toBe(403);
    expect((await call("GET", "", { read }, undefined, "not-a-uuid")).statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("checklist request parsers", () => {
  it("take exactly what the dashboards send", () => {
    expect(parseChecklistAcknowledgement({ item: "guest_terms" })).toBe("guest_terms");
    expect(parseChecklistAcknowledgement({ item: "style" })).toBeNull();
    expect(parseChecklistViewerChange({ hidden: false, dismissed: true })).toEqual({
      hidden: false,
      dismissed: true,
    });
    expect(parseChecklistViewerChange({ dismissed: 1 })).toBeNull();
  });
});
