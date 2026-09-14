import type { RequestContext } from "@vayada/backend-auth";
import Fastify, { type FastifyRequest } from "fastify";
import { loadConfig } from "./config.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPmsOperationsRoutes,
  type PmsOperationsReadRepository,
} from "./routes/pmsOperations.js";
import type { PmsRoomClosureRepository } from "./domains/pmsRoomClosureCommandRepository.js";

const propertyId = "87000000-0000-4000-8000-000000000001";
const roomTypeId = "87000000-0000-4000-8000-000000000002";
const organizationId = "87000000-0000-4000-8000-000000000003";
const actorUserId = "87000000-0000-4000-8000-000000000004";
const endpoint = `/properties/${propertyId}/room-types/${roomTypeId}`;
const body = {
  expectedRoomFactsRevision: 3,
  expectedRoomUnitsRevision: 5,
  expectedCalendarRevision: 7,
  expectedActivePublicationRevisionId: null,
};
const auth = {
  actor: { internalUserId: actorUserId },
  selectedOrganization: { organizationId, kind: "hotel_group" },
  membership: { permissions: ["pms.operations.manage"] },
  entitlements: [
    {
      product: "pms",
      key: "property-management",
      status: "active",
      resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
    },
  ],
  linkedResources: [
    {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      relationship: "operator",
      status: "active",
    },
  ],
  audit: { requestId: "request-1", source: "api" },
} as RequestContext;

describe("protected PMS room closure endpoints", () => {
  let app: ReturnType<typeof Fastify>;
  afterEach(async () => {
    await app?.close();
  });
  async function setup(context = auth, enabled = true) {
    app = Fastify({ logger: false });
    const port = {
      preview: vi.fn<PmsRoomClosureRepository["preview"]>(),
      closeRoom: vi.fn<PmsRoomClosureRepository["closeRoom"]>(),
      dispose: vi.fn(async () => {}),
    };
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request: FastifyRequest) => {
      if (request.headers.authorization === "Bearer valid") request.authContext = context;
    });
    await app.register(registerPmsOperationsRoutes, {
      repository: {} as PmsOperationsReadRepository,
      roomClosureRepository: enabled ? port : undefined,
      allowedOrigins: ["https://pms.example.test"],
    });
    return port;
  }
  const send = (
    method: "GET" | "POST" = "POST",
    payload: unknown = body,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: `${endpoint}/${method === "GET" ? "closure-impact" : "close"}`,
      headers: { authorization: "Bearer valid", "idempotency-key": "closure-key", ...headers },
      ...(method === "POST" ? { payload } : {}),
    });
  it("defaults the rollout off and leaves closure routes unavailable without the port", async () => {
    expect(loadConfig({}).pmsRoomClosureEnabled).toBe(false);
    expect(loadConfig({ PMS_ROOM_CLOSURE_ENABLED: "true" }).pmsRoomClosureEnabled).toBe(true);
    const port = await setup(auth, false);
    for (const method of ["GET", "POST"] as const)
      expect((await send(method)).statusCode).toBe(404);
    expect(port.closeRoom).not.toHaveBeenCalled();
  });
  it("dispatches only server-owned tenant/actor scope and required revisions", async () => {
    const port = await setup();
    port.preview.mockResolvedValue({ ok: false, error: { code: "room_type_not_found" } });
    port.closeRoom.mockResolvedValue({
      ok: true,
      propertyId,
      roomTypeId,
      commandId: "command",
      calendarRevision: 8,
      roomUnitsRevision: 6,
      cutoffDate: "2026-09-09",
      retiredUnitIds: [],
      closedInventoryDays: 3,
      suppressedOfferDays: 3,
      phase: "publication_refresh_required",
    });
    expect((await send("GET")).statusCode).toBe(404);
    const result = await send();
    expect(result.statusCode).toBe(200);
    expect(result.json().phase).toBe("publication_refresh_required");
    expect(port.preview).toHaveBeenCalledWith({
      propertyId,
      roomTypeId,
      organizationId,
      actorUserId,
    });
    expect(port.closeRoom).toHaveBeenCalledWith({
      ...body,
      propertyId,
      roomTypeId,
      organizationId,
      actorUserId,
      idempotencyKey: "closure-key",
      requestId: "request-1",
      correlationId: undefined,
    });
  });
  it.each(["", "Bearer invalid"])(
    "rejects missing/invalid authentication %s",
    async (authorization) => {
      const port = await setup();
      for (const method of ["GET", "POST"] as const)
        expect((await send(method, body, { authorization })).statusCode).toBe(401);
      expect(port.preview).not.toHaveBeenCalled();
      expect(port.closeRoom).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["permission", { membership: { ...auth.membership, permissions: [] } }],
    ["entitlement", { entitlements: [] }],
    [
      "inactive entitlement",
      {
        entitlements: auth.entitlements.map((entitlement) => ({
          ...entitlement,
          status: "suspended",
        })),
      },
    ],
    ["resource", { linkedResources: [] }],
    [
      "cross-property resource",
      {
        linkedResources: auth.linkedResources.map((resource) => ({
          ...resource,
          resourceId: roomTypeId,
        })),
      },
    ],
    [
      "front desk",
      {
        linkedResources: auth.linkedResources.map((resource) => ({
          ...resource,
          relationship: "front_desk",
        })),
      },
    ],
  ])("rejects missing or ineligible %s before dispatch", async (_name, overrides) => {
    const port = await setup({ ...auth, ...overrides } as RequestContext);
    for (const method of ["GET", "POST"] as const)
      expect((await send(method)).statusCode).toBe(403);
    expect(port.preview).not.toHaveBeenCalled();
    expect(port.closeRoom).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { ...body, expectedRoomFactsRevision: "3" },
    { ...body, expectedRoomUnitsRevision: 0 },
    { ...body, expectedCalendarRevision: 1.5 },
    { ...body, expectedActivePublicationRevisionId: "invalid" },
    { ...body, organizationId },
    { ...body, actorUserId },
    { ...body, sql: "arbitrary" },
  ])("rejects malformed or caller-controlled scope %j", async (payload) => {
    const port = await setup();
    expect((await send("POST", payload)).statusCode).toBe(400);
    expect(port.closeRoom).not.toHaveBeenCalled();
  });
  it("requires one idempotency key and rejects unauthorized origins", async () => {
    const port = await setup();
    expect((await send("POST", body, { "idempotency-key": "" })).statusCode).toBe(400);
    expect((await send("POST", body, { origin: "https://untrusted.example" })).statusCode).toBe(
      403,
    );
    expect(port.closeRoom).not.toHaveBeenCalled();
  });
  it.each(["room_closure_protected", "channex_closure_mode_unsupported"])(
    "preserves %s conflicts",
    async (code) => {
      const port = await setup();
      const failure = {
        ok: false as const,
        error: { code, blockers: ["active_reservations"] },
      };
      port.closeRoom.mockResolvedValue(failure);
      const result = await send();
      expect(result.statusCode).toBe(409);
      expect(result.json()).toEqual(failure);
    },
  );
});
