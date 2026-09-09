import type { RequestContext } from "@vayada/backend-auth";
import {
  CHANNEX_MANAGEMENT_CONTRACT_VERSION,
  type ChannexManagementCapabilityModes,
  type ChannexManagementOperation,
} from "@vayada/domain-pms-channex";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PmsChannexManagementCommandPort } from "./domains/pmsChannexManagementCommands.js";
import type { PmsChannexManagementReadRepository } from "./domains/pmsChannexManagementReadModel.js";
import { registerPmsChannexManagementRoutes } from "./routes/pmsChannexManagement.js";

const propertyId = "123e4567-e89b-42d3-a456-426614174000";
const operationId = "223e4567-e89b-42d3-a456-426614174000";
const mutating: ChannexManagementCapabilityModes = {
  connection: "mutating",
  provisioning: "mutating",
  ariSync: "mutating",
  bookingSync: "mutating",
  markups: "mutating",
  messaging: "mutating",
  iframe: "observe_only",
};

type Access = {
  authenticated?: boolean;
  permission?: boolean;
  permissions?: Array<"pms.operations.read" | "pms.operations.manage">;
  entitlement?: "active" | "suspended" | "missing";
  linked?: boolean;
  relationship?: "operator" | "finance_manager";
};

describe("PMS Channex management command routes", () => {
  let app: ReturnType<typeof Fastify> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it.each([
    [{ authenticated: false }, 401],
    [{ permission: false }, 403],
    [{ entitlement: "missing" }, 403],
    [{ entitlement: "suspended" }, 403],
    [{ linked: false }, 403],
    [{ relationship: "finance_manager" }, 403],
  ] as const)("denies unauthorized command access %#", async (access, statusCode) => {
    const harness = await testApp(access);
    app = harness.app;

    expect((await command(app)).statusCode).toBe(statusCode);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/properties/${propertyId}/channex/stay-restrictions`,
          headers: { authorization: "Bearer valid" },
          payload: {},
        })
      ).statusCode,
    ).toBe(statusCode);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/properties/${propertyId}/channex/stay-restrictions`,
          headers: { authorization: "Bearer valid" },
        })
      ).statusCode,
    ).toBe(statusCode);
    for (const [method, path] of [
      ["GET", "alerts"],
      ["POST", `alerts/${operationId}/recover`],
      ["POST", `alerts/${operationId}/acknowledge`],
    ] as const) {
      expect(
        (
          await app.inject({
            method,
            url: `/properties/${propertyId}/channex/${path}`,
            headers: { authorization: "Bearer valid" },
            ...(method === "POST" ? { payload: { round: 0 } } : {}),
          })
        ).statusCode,
      ).toBe(statusCode);
    }
    expect((await datePrice(app)).statusCode).toBe(statusCode);
    expect(harness.putDatePrice).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/properties/${propertyId}/channex/inventory-rules`,
          headers: { authorization: "Bearer valid" },
          payload: {
            commandId: "rule-command",
            idempotencyKey: "rule-key",
            expectedOperationId: null,
            rules: [],
          },
        })
      ).statusCode,
    ).toBe(statusCode);
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/properties/${propertyId}/reservations/booking-1/no-show-report`,
          headers: { authorization: "Bearer valid" },
          payload: { waivedFees: false, retry: false },
        })
      ).statusCode,
    ).toBe(statusCode);
    expect(harness.reportSubmit).not.toHaveBeenCalled();
  });

  it("requires an explicit fee choice and property-scoped authorization for reporting", async () => {
    const harness = await testApp();
    app = harness.app;
    const call = (payload: unknown, property = propertyId) =>
      app!.inject({
        method: "POST",
        url: `/properties/${property}/reservations/booking-1/no-show-report`,
        headers: { authorization: "Bearer valid" },
        payload,
      });
    expect((await call({ retry: false })).statusCode).toBe(400);
    expect((await call({ waivedFees: false, retry: false }, operationId)).statusCode).toBe(403);
    expect(harness.reportSubmit).not.toHaveBeenCalled();
    expect((await call({ waivedFees: false, retry: false })).statusCode).toBe(202);
    expect(harness.reportSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { internalUserId: "actor-1" } }),
      propertyId,
      "booking-1",
      false,
      false,
    );
    await app.close();
    const disabled = await testApp({}, { ...mutating, bookingSync: "observe_only" });
    app = disabled.app;
    expect((await call({ waivedFees: false, retry: false })).statusCode).toBe(409);
    expect(disabled.reportSubmit).not.toHaveBeenCalled();
  });

  it("saves/removes validated date prices and honors the ARI cutover guard", async () => {
    const harness = await testApp();
    app = harness.app;
    expect((await datePrice(app)).statusCode).toBe(200);
    expect(harness.putDatePrice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountDecimal: "80.00", expectedRevision: 0 }),
    );
    expect((await datePrice(app, { amountDecimal: null })).statusCode).toBe(200);
    for (const amountDecimal of ["0.00", "-1.00", "1.005", 100]) {
      expect((await datePrice(app, { amountDecimal })).statusCode).toBe(400);
    }
    await app.close();
    const guarded = await testApp({}, { ...mutating, ariSync: "observe_only" });
    app = guarded.app;
    expect((await datePrice(app)).statusCode).toBe(409);
    expect(guarded.putDatePrice).not.toHaveBeenCalled();
  });

  it("denies recovery to a member with read-only PMS permission", async () => {
    const harness = await testApp({ permissions: ["pms.operations.read"] });
    app = harness.app;
    const response = await app.inject({
      method: "POST",
      url: `/properties/${propertyId}/channex/alerts/${operationId}/recover`,
      headers: { authorization: "Bearer valid" },
      payload: { round: 0 },
    });
    expect(response.statusCode).toBe(403);
    expect(harness.recoverAlert).not.toHaveBeenCalled();
  });

  it("authorizes property alert reads and recovery, and rejects another property", async () => {
    const harness = await testApp();
    app = harness.app;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/properties/${propertyId}/channex/alerts`,
          headers: { authorization: "Bearer valid" },
        })
      ).statusCode,
    ).toBe(200);
    const recover = (scope = propertyId) =>
      app!.inject({
        method: "POST",
        url: `/properties/${scope}/channex/alerts/${operationId}/recover`,
        headers: { authorization: "Bearer valid" },
        payload: { round: 0 },
      });
    expect((await recover()).statusCode).toBe(202);
    expect((await recover(operationId)).statusCode).toBe(403);
    expect(harness.recoverAlert).toHaveBeenCalledTimes(1);
    await app.close();
    const blocked = await testApp({}, { ...mutating, ariSync: "observe_only" });
    app = blocked.app;
    expect((await recover()).statusCode).toBe(409);
    expect(blocked.recoverAlert).not.toHaveBeenCalled();
  });

  it("queues an authorized command and preserves actor context", async () => {
    const harness = await testApp();
    app = harness.app;

    const response = await command(app);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(operation());
    expect(harness.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { internalUserId: "actor-1" } }),
      propertyId,
      {
        commandId: "command-1",
        idempotencyKey: "key-1",
        operationType: "enable",
      },
    );
  });

  it("fails closed for observe-only capabilities and invalid payloads", async () => {
    const harness = await testApp({}, { ...mutating, connection: "observe_only" });
    app = harness.app;

    expect((await command(app)).json()).toEqual({ code: "channex_capability_not_mutating" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/properties/${propertyId}/channex/commands`,
          headers: { authorization: "Bearer valid" },
          payload: { operationType: "webhook_setup" },
        })
      ).statusCode,
    ).toBe(400);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("applies authentication policy before command or markup validation", async () => {
    const harness = await testApp({ authenticated: false });
    app = harness.app;
    for (const [method, path] of [
      ["POST", "commands"],
      ["PUT", "markups"],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/properties/${propertyId}/channex/${path}`,
        payload: { malformed: true },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("validates and queues target-owned markups", async () => {
    const harness = await testApp();
    app = harness.app;
    const response = await app.inject({
      method: "PUT",
      url: `/properties/${propertyId}/channex/markups`,
      headers: { authorization: "Bearer valid" },
      payload: {
        commandId: "command-2",
        idempotencyKey: "key-2",
        markups: [{ channel: "airbnb", markupPercent: 12.5 }],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(harness.enqueue).toHaveBeenCalledWith(expect.anything(), propertyId, {
      commandId: "command-2",
      idempotencyKey: "key-2",
      operationType: "update_markups",
      markups: [{ channel: "airbnb", markupPercent: 12.5 }],
    });

    const invalid = await app.inject({
      method: "PUT",
      url: `/properties/${propertyId}/channex/markups`,
      headers: { authorization: "Bearer valid" },
      payload: {
        commandId: "command-3",
        idempotencyKey: "key-3",
        markups: [{ channel: "direct", markupPercent: 10 }],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("accepts rule replacement only through the guarded inventory route", async () => {
    const harness = await testApp();
    app = harness.app;
    const request = {
      method: "PUT" as const,
      url: `/properties/${propertyId}/channex/inventory-rules`,
      headers: { authorization: "Bearer valid" },
      payload: {
        commandId: "rules",
        idempotencyKey: "rules",
        expectedOperationId: null,
        rules: [],
      },
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    expect(harness.enqueue).toHaveBeenCalledWith(expect.anything(), propertyId, {
      commandId: "rules",
      idempotencyKey: "rules",
      operationType: "update_inventory_rules",
      inventoryRules: { expectedOperationId: null, rules: [] },
    });
    expect(
      (await app.inject({ ...request, url: `/properties/${operationId}/channex/inventory-rules` }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          payload: { ...request.payload, expectedOperationId: "invalid" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          ...request,
          method: "POST",
          url: `/properties/${propertyId}/channex/commands`,
          payload: {
            commandId: "rules",
            idempotencyKey: "rules",
            operationType: "update_inventory_rules",
          },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
    const observe = await testApp({}, { ...mutating, ariSync: "observe_only" });
    app = observe.app;
    expect((await app.inject(request)).statusCode).toBe(409);
    expect(observe.enqueue).not.toHaveBeenCalled();
  });

  it("validates restriction scope and queues explicit empty resets", async () => {
    const harness = await testApp();
    app = harness.app;
    const request = {
      method: "PUT" as const,
      url: `/properties/${propertyId}/channex/stay-restrictions`,
      headers: { authorization: "Bearer valid" },
      payload: {
        commandId: "restriction-1",
        idempotencyKey: "restriction-1",
        restrictions: { roomTypeId: propertyId, ratePlanId: null, rules: [] },
      },
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    expect(harness.enqueue).toHaveBeenCalledWith(expect.anything(), propertyId, {
      ...request.payload,
      operationType: "sync_ari",
    });
    expect(
      (
        await app.inject({
          ...request,
          payload: {
            ...request.payload,
            restrictions: {
              ...request.payload.restrictions,
              rules: [{ minStayNights: 0 }],
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
    app = null;
    app = (await testApp({}, { ...mutating, ariSync: "observe_only" })).app;
    expect((await app.inject(request)).statusCode).toBe(409);
  });

  it("guards short-lived iframe sessions with the iframe cutover mode", async () => {
    let harness = await testApp({}, { ...mutating, iframe: "mutating" });
    app = harness.app;
    const unavailable = await app.inject({
      method: "POST",
      url: `/properties/${propertyId}/channex/iframe-session`,
      headers: { authorization: "Bearer valid" },
    });
    expect(unavailable).toMatchObject({ statusCode: 503 });
    await app.close();

    harness = await testApp({}, { ...mutating, iframe: "observe_only" });
    app = harness.app;
    const disabled = await app.inject({
      method: "POST",
      url: `/properties/${propertyId}/channex/iframe-session`,
      headers: { authorization: "Bearer valid" },
    });
    expect(disabled).toMatchObject({ statusCode: 409 });
  });
});

async function testApp(
  access: Access = {},
  capabilityModes: ChannexManagementCapabilityModes = mutating,
) {
  const app = Fastify({ logger: false });
  const recoverAlert = vi.fn().mockResolvedValue({ ok: true });
  const enqueue = vi.fn<PmsChannexManagementCommandPort["enqueue"]>();
  const reportSubmit = vi.fn().mockResolvedValue({
    eligible: true,
    reason: null,
    localNoShow: true,
    status: "pending",
    retryable: false,
    waivedFees: false,
  });
  enqueue.mockResolvedValue({ ok: true, operation: operation(), replayed: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid" || access.authenticated === false) return;
    request.authContext = context(access);
  });
  const putDatePrice = vi
    .fn()
    .mockResolvedValue({ amountDecimal: "80.00", currency: "EUR", revision: 1 });
  await app.register(registerPmsChannexManagementRoutes, {
    datePrices: { put: putDatePrice, get: vi.fn().mockResolvedValue(null), close: vi.fn() },
    repository: {
      ...repository(),
      getAlerts: async () => [
        {
          id: operationId,
          eventType: "sync_error",
          impact: {
            bookingId: null,
            revisionId: null,
            channelId: null,
            channel: null,
            roomTypeId: null,
            ratePlanId: null,
            dateFrom: null,
            dateTo: null,
            errorType: null,
          },
          firstOccurredAt: "2026-09-01T00:00:00Z",
          lastOccurredAt: "2026-09-01T00:00:00Z",
          acknowledgedAt: null,
          resolvedAt: null,
          recoveryRound: 0,
          occurrences: 1,
          recovery: [],
        },
      ],
    },
    capabilityModes,
    commandPort: { enqueue, recoverAlert },
    noShowReports: { get: vi.fn(), submit: reportSubmit },
    noShowReportingEnabled: capabilityModes.bookingSync === "mutating",
  });
  return { app, enqueue, putDatePrice, recoverAlert, reportSubmit };
}

function context(access: Access): RequestContext {
  const entitlement = access.entitlement ?? "active";
  return {
    actor: { internalUserId: "actor-1" },
    selectedOrganization: { organizationId: "organization-1", kind: "hotel_group" },
    membership: {
      permissions:
        access.permission === false
          ? []
          : (access.permissions ?? ["pms.operations.manage", "pms.operations.read"]),
    },
    entitlements:
      entitlement === "missing"
        ? []
        : [
            {
              product: "pms",
              key: "property-management",
              status: entitlement,
              resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
            },
          ],
    linkedResources:
      access.linked === false
        ? []
        : [
            {
              product: "pms",
              resourceType: "pms_property",
              resourceId: propertyId,
              relationship: access.relationship ?? "operator",
              status: "active",
            },
          ],
    audit: { requestId: "request-1", source: "api", receivedAt: "2026-08-13T10:00:00.000Z" },
  } as RequestContext;
}

function repository(): PmsChannexManagementReadRepository {
  return {
    async getSnapshot() {
      throw new Error("not used");
    },
    async getOperation() {
      return null;
    },
  };
}

function operation(): ChannexManagementOperation {
  return {
    contractVersion: CHANNEX_MANAGEMENT_CONTRACT_VERSION,
    operationId,
    propertyId,
    operationType: "enable",
    status: "queued",
    commandId: "command-1",
    idempotencyKey: "key-1",
    acceptedAt: "2026-08-13T10:00:00.000Z",
    attemptsMade: 0,
    maxAttempts: 5,
    retryAfter: null,
    lastError: null,
  };
}

function command(app: ReturnType<typeof Fastify>) {
  return app.inject({
    method: "POST",
    url: `/properties/${propertyId}/channex/commands`,
    headers: { authorization: "Bearer valid" },
    payload: { commandId: "command-1", idempotencyKey: "key-1", operationType: "enable" },
  });
}

function datePrice(app: ReturnType<typeof Fastify>, override: Record<string, unknown> = {}) {
  return app.inject({
    method: "PUT",
    headers: { authorization: "Bearer valid" },
    url: `/properties/${propertyId}/channex/room-types/${operationId}/rate-plans/${operationId}/date-prices/2026-12-31`,
    payload: {
      commandId: operationId,
      expectedRevision: 0,
      amountDecimal: "80.00",
      currency: "EUR",
      ...override,
    },
  });
}
