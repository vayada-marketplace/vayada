import { request as httpRequest } from "node:http";

import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  MARKETPLACE_COMMUNICATIONS_INITIAL_POLICY,
  type MarketplaceCommunicationPreferencesV1,
  type ReplaceMarketplaceCommunicationPreferencesCommand,
  type ReplaceMarketplaceCommunicationPreferencesResult,
} from "@vayada/domain-marketplace";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerMarketplaceCommunicationPreferencesRoutes,
  type MarketplaceCommunicationPreferencesRoutesOptions,
} from "./routes/marketplaceCommunicationPreferences.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const profileId = "33333333-3333-4333-8333-333333333333";
const otherOrganizationId = "44444444-4444-4444-8444-444444444444";
const now = "2026-09-16T14:00:00.000Z";

type AuthOptions = {
  actorStatus?: RequestContext["actor"]["status"];
  organizationStatus?: RequestContext["selectedOrganization"]["status"];
  membershipStatus?: RequestContext["membership"]["status"];
  kind?: RequestContext["selectedOrganization"]["kind"];
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};
type FakePorts = MarketplaceCommunicationPreferencesRoutesOptions & {
  commands: ReplaceMarketplaceCommunicationPreferencesCommand[];
  reads: unknown[];
};

function requestBody(expectedRevision = 0) {
  return {
    contractVersion: "marketplace-communications.v1",
    expectedRevision,
    email: { state: "off" },
    topics: { collaborationActionRequired: { cadence: "off" } },
  } as const;
}

function preferences(
  revision = 1,
  targetOrganizationId = organizationId,
  source: MarketplaceCommunicationPreferencesV1["email"]["source"] = "settings",
): MarketplaceCommunicationPreferencesV1 {
  return {
    contractVersion: "marketplace-communications.v1",
    organizationId: targetOrganizationId,
    revision,
    email: { state: "off", source, effectiveAt: now },
    topics: {
      collaborationActionRequired: { cadence: "off", source, effectiveAt: now },
    },
  };
}

function hotelLink(overrides: Partial<LinkedResource> = {}): LinkedResource {
  return {
    product: "marketplace",
    resourceType: "hotel_profile",
    resourceId: profileId,
    relationship: "operator",
    status: "active",
    ...overrides,
  };
}

function creatorLink(resourceId = profileId): LinkedResource {
  return {
    product: "marketplace",
    resourceType: "creator_profile",
    resourceId,
    relationship: "owner",
    status: "active",
  };
}

function entitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return { product: "marketplace", key: "marketplace-hotel-profile", status };
}

function fakePorts(overrides: { read?: unknown; result?: unknown } = {}): FakePorts {
  const commands: ReplaceMarketplaceCommunicationPreferencesCommand[] = [];
  const reads: unknown[] = [];
  return {
    commands,
    reads,
    policy: MARKETPLACE_COMMUNICATIONS_INITIAL_POLICY,
    readPort: {
      async getCommunicationPreferences(scope) {
        reads.push(scope);
        return (overrides.read ?? preferences()) as MarketplaceCommunicationPreferencesV1;
      },
    },
    commandPort: {
      async replaceCommunicationPreferences(command) {
        commands.push(command);
        return (overrides.result ?? {
          ok: true,
          preferences: preferences(command.request.expectedRevision + 1),
        }) as ReplaceMarketplaceCommunicationPreferencesResult;
      },
    },
  };
}

async function testApp(ports: FakePorts, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: userId, status: auth.actorStatus ?? "active" },
      selectedOrganization: {
        organizationId,
        kind: auth.kind ?? "hotel_group",
        status: auth.organizationStatus ?? "active",
      },
      membership: {
        status: auth.membershipStatus ?? "active",
        permissions: auth.permissions ?? ["marketplace.collaboration.write"],
      },
      linkedResources: auth.links ?? [hotelLink()],
      entitlements: auth.entitlements ?? [entitlement()],
      audit: {
        requestId: "request-2023",
        correlationId: "correlation-2023",
        source: "api",
        receivedAt: now,
      },
    } as RequestContext;
  });
  await app.register(registerMarketplaceCommunicationPreferencesRoutes, ports);
  return app;
}

async function get(app: Awaited<ReturnType<typeof testApp>>, token: string | null = "valid-token") {
  return injectJson<{ error?: { code: string }; revision?: number }>(app, {
    method: "GET",
    url: "/communication-preferences",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function put(
  app: Awaited<ReturnType<typeof testApp>>,
  options: { body?: unknown; key?: string | null; token?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? "valid-token"}`;
  if (options.key !== null) headers["idempotency-key"] = options.key ?? "preferences-key";
  return injectJson<{ error?: { code: string }; revision?: number }>(app, {
    method: "PUT",
    url: "/communication-preferences",
    headers,
    payload: options.body ?? requestBody(),
  });
}

async function repeatedKey(app: Awaited<ReturnType<typeof testApp>>) {
  const payload = JSON.stringify(requestBody());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "PUT",
        path: "/communication-preferences",
        headers: {
          authorization: "Bearer valid-token",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "idempotency-key": ["first", "second"],
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

describe("Marketplace communication preference routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("reads only the actor's selected-organization document with audited defaults", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await get(app);

    expect(response.statusCode).toBe(200);
    expect(response.body.revision).toBe(1);
    expect(ports.reads).toEqual([
      { organizationId, userId, policy: MARKETPLACE_COMMUNICATIONS_INITIAL_POLICY },
    ]);
  });

  it("replaces only the actor's document and preserves an exact replay", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await put(app, { key: "  stable-key  " });
    const replay = await put(app, { key: "  stable-key  " });

    expect(response.statusCode).toBe(200);
    expect(replay).toEqual(response);
    expect(ports.commands[0]).toEqual({
      organizationId,
      userId,
      idempotencyKey: "stable-key",
      audit: {
        actorUserId: userId,
        requestId: "request-2023",
        correlationId: "correlation-2023",
        requestedAt: now,
      },
      request: requestBody(),
    });
    expect(ports.commands[1]).toEqual(ports.commands[0]);
  });

  it("allows the creator-workspace owner-link policy without inventing an entitlement", async () => {
    const ports = fakePorts();
    app = await testApp(ports, {
      kind: "creator_workspace",
      links: [creatorLink()],
      entitlements: [],
    });
    expect((await get(app)).statusCode).toBe(200);
    expect((await put(app)).statusCode).toBe(200);
  });

  it.each([
    ["missing authentication", {}, null, 401],
    ["inactive actor", { actorStatus: "suspended" }, "valid-token", 403],
    ["inactive organization", { organizationStatus: "suspended" }, "valid-token", 403],
    ["inactive membership", { membershipStatus: "suspended" }, "valid-token", 403],
    ["missing permission", { permissions: [] }, "valid-token", 403],
    ["missing entitlement", { entitlements: [] }, "valid-token", 403],
    ["inactive entitlement", { entitlements: [entitlement("suspended")] }, "valid-token", 403],
    ["missing resource link", { links: [] }, "valid-token", 403],
    ["inactive resource link", { links: [hotelLink({ status: "suspended" })] }, "valid-token", 403],
    [
      "wrong relationship",
      { links: [hotelLink({ relationship: "front_desk" })] },
      "valid-token",
      403,
    ],
    ["unsupported organization", { kind: "platform" }, "valid-token", 403],
    [
      "ambiguous creator links",
      { kind: "creator_workspace", links: [creatorLink(), creatorLink(otherOrganizationId)] },
      "valid-token",
      403,
    ],
  ] as const)("denies reads and writes for %s", async (_label, auth, token, status) => {
    const ports = fakePorts();
    app = await testApp(ports, auth as AuthOptions);
    const read = await get(app, token);
    const write = await put(app, { token });

    expect(read).toMatchObject({
      statusCode: status,
      body: { error: { code: status === 401 ? "unauthenticated" : "forbidden" } },
    });
    expect(write.statusCode).toBe(status);
    expect(ports.reads).toHaveLength(0);
    expect(ports.commands).toHaveLength(0);
  });

  it.each([
    ["unknown field", { ...requestBody(), organizationId }],
    ["null email", { ...requestBody(), email: null }],
    ["negative revision", { ...requestBody(), expectedRevision: -1 }],
    ["fractional revision", { ...requestBody(), expectedRevision: 0.5 }],
  ])("rejects %s with the exact invalid-request envelope", async (_label, body) => {
    const ports = fakePorts();
    app = await testApp(ports);
    expect(await put(app, { body })).toEqual({
      statusCode: 400,
      body: { error: { code: "invalid_request" } },
    });
    expect(ports.commands).toHaveLength(0);
  });

  it.each([null, "   ", "x".repeat(201)])("rejects an invalid idempotency key", async (key) => {
    const ports = fakePorts();
    app = await testApp(ports);
    expect((await put(app, { key })).statusCode).toBe(400);
    expect(ports.commands).toHaveLength(0);
  });

  it("rejects repeated Idempotency-Key headers", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    expect(await repeatedKey(app)).toBe(400);
    expect(ports.commands).toHaveLength(0);
  });

  it.each([
    ["malformed JSON", "application/json", "{"],
    ["empty JSON", "application/json", ""],
    ["unsupported media", "application/xml", "<request />"],
    ["oversized JSON", "application/json", JSON.stringify({ value: "x".repeat(1_048_576) })],
  ])("uses the exact envelope for %s", async (_label, contentType, payload) => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await app.inject({
      method: "PUT",
      url: "/communication-preferences",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": contentType,
        "idempotency-key": "preferences-key",
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "invalid_request" } });
  });

  it("authorizes before parsing malformed JSON", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await app.inject({
      method: "PUT",
      url: "/communication-preferences",
      headers: { "content-type": "application/json", "idempotency-key": "preferences-key" },
      payload: "{",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: "unauthenticated" } });
  });

  it.each([
    [{ code: "preference_conflict", currentRevision: 2 }, "preference_conflict", 409],
    [{ code: "idempotency_conflict" }, "idempotency_conflict", 409],
    [{ code: "command_in_progress" }, "command_in_progress", 409],
    [{ code: "scope_forbidden" }, "forbidden", 403],
  ] as const)("maps %o to the exact HTTP envelope", async (error, code, status) => {
    const ports = fakePorts({ result: { ok: false, error } });
    app = await testApp(ports);
    expect(await put(app)).toEqual({ statusCode: status, body: { error: { code } } });
  });

  it.each([
    ["cross-organization read", { read: preferences(1, otherOrganizationId) }],
    [
      "cross-organization write",
      { result: { ok: true, preferences: preferences(1, otherOrganizationId) } },
    ],
    ["impossible initial revision", { result: { ok: true, preferences: preferences(0) } }],
    ["impossible revision", { result: { ok: true, preferences: preferences(3) } }],
    [
      "non-settings provenance",
      { result: { ok: true, preferences: preferences(1, organizationId, "policy_default") } },
    ],
    [
      "different preference values",
      {
        result: {
          ok: true,
          preferences: { ...preferences(), email: { ...preferences().email, state: "on" } },
        },
      },
    ],
    [
      "non-conflicting conflict",
      { result: { ok: false, error: { code: "preference_conflict", currentRevision: 0 } } },
    ],
    ["malformed result", { result: { ok: true } }],
  ])("fails closed for %s port data", async (_label, overrides) => {
    const ports = fakePorts(overrides);
    app = await testApp(ports);
    const response = "read" in overrides ? await get(app) : await put(app);
    expect(response).toEqual({ statusCode: 500, body: { error: { code: "internal_error" } } });
  });
});
