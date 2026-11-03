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
const checklist = { contractVersion: "hotel-setup-checklist.v2", propertyId, phase: "go_live" };

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

describe("go-live checklist routes (VAY-2247 wave 2, VAY-2451)", () => {
  it("GET /v2 returns the go-live list for the signed-in person", async () => {
    const readGoLive = vi.fn(async () => checklist as never);
    const response = await call("GET", "/v2", { readGoLive });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(checklist);
    expect(readGoLive).toHaveBeenCalledWith(actor);
  });

  it("GET /v2 says when the hotel isn't there", async () => {
    const response = await call("GET", "/v2", { readGoLive: vi.fn(async () => null) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "property_not_found" });
  });

  it("serves no first checklist (v1) any more", async () => {
    const readGoLive = vi.fn(async () => checklist as never);
    const acknowledge = vi.fn(async () => checklist as never);
    const setViewer = vi.fn(async () => checklist as never);
    expect((await call("GET", "", { readGoLive })).statusCode).toBe(404);
    expect(
      (await call("POST", "/acknowledgements", { acknowledge }, { item: "guest_terms" }))
        .statusCode,
    ).toBe(404);
    expect((await call("PUT", "/viewer", { setViewer }, { hidden: true })).statusCode).toBe(404);
    expect(readGoLive).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(setViewer).not.toHaveBeenCalled();
  });

  it("POST /v2/acknowledgements records Looks good for guest terms (or calendar)", async () => {
    const acknowledge = vi.fn(async () => checklist as never);
    const response = await call(
      "POST",
      "/v2/acknowledgements",
      { acknowledge },
      { item: "guest_terms" },
    );
    expect(response.statusCode).toBe(200);
    expect(acknowledge).toHaveBeenCalledWith(actor, "guest_terms");
    for (const invalid of [{ item: "photos" }, { item: "calendar", extra: 1 }, {}, null])
      expect(
        (await call("POST", "/v2/acknowledgements", { acknowledge }, invalid)).statusCode,
      ).toBe(400);
  });

  it("PUT /v2/viewer changes only the signed-in person's Hide for now and Dismiss", async () => {
    const setViewer = vi.fn(async () => checklist as never);
    const response = await call("PUT", "/v2/viewer", { setViewer }, { dismissed: true });
    expect(response.statusCode).toBe(200);
    expect(setViewer).toHaveBeenCalledWith(actor, { dismissed: true });
    for (const invalid of [{}, { hidden: "yes" }, { hidden: true, other: true }])
      expect((await call("PUT", "/v2/viewer", { setViewer }, invalid)).statusCode).toBe(400);
  });

  it("needs a signed-in session on a hotel group and a property in scope", async () => {
    const readGoLive = vi.fn();
    policy.context = context({ sessionId: null });
    expect((await call("GET", "/v2", { readGoLive })).statusCode).toBe(403);
    policy.context = context({ kind: "creator" });
    expect((await call("GET", "/v2", { readGoLive })).statusCode).toBe(403);
    policy.context = context();
    const other = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
    expect((await call("GET", "/v2", { readGoLive }, undefined, other)).statusCode).toBe(403);
    expect((await call("GET", "/v2", { readGoLive }, undefined, "not-a-uuid")).statusCode).toBe(
      400,
    );
    expect(readGoLive).not.toHaveBeenCalled();
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
