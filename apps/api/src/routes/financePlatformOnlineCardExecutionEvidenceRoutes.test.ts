import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import type { FinancePlatformOnlineCardExecutionEvidenceRepository } from "@vayada/domain-finance";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerFinancePlatformOnlineCardExecutionEvidenceRoutes } from "./financePlatformOnlineCardExecutionEvidenceRoutes.js";

const PLATFORM_ORG = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "30000000-0000-4000-8000-000000000001";
const EVIDENCE_ID = "40000000-0000-4000-8000-000000000001";

const entitlement: ProductEntitlement = {
  product: "platform",
  key: "finance-admin",
  status: "active",
  resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
};

const link: LinkedResource = {
  product: "platform",
  resourceType: "platform",
  resourceId: "vayada",
  relationship: "operator",
  status: "active",
};

type AuthOptions = {
  authenticated?: boolean;
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
  kind?: RequestContext["selectedOrganization"]["kind"];
  role?: string;
};

async function testApp(
  repo: Partial<FinancePlatformOnlineCardExecutionEvidenceRepository>,
  auth: AuthOptions = {},
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (auth.authenticated === false || request.headers.authorization !== "Bearer valid") return;
    request.authContext = {
      actor: {
        internalUserId: USER_ID,
        providerIdentity: { provider: "workos", providerUserId: "workos-user" },
        email: "finance@example.com",
        status: "active",
      },
      selectedOrganization: {
        organizationId: PLATFORM_ORG,
        kind: auth.kind ?? "platform",
        status: "active",
      },
      membership: {
        membershipId: "membership-1",
        status: "active",
        roleKey: auth.role ?? "platform_admin",
        workosRoleSlugs: [auth.role ?? "platform_admin"],
        permissions: auth.permissions ?? ["platform.finance.read", "platform.finance.manage"],
      },
      linkedResources: auth.links ?? [link],
      entitlements: auth.entitlements ?? [entitlement],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "admin",
        receivedAt: "2026-08-28T10:30:00.000Z",
      },
    };
  });
  await app.register(registerFinancePlatformOnlineCardExecutionEvidenceRoutes, {
    repository: repo,
  });
  return app;
}

describe("Platform Finance online-card execution evidence routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("lets platform finance read a hotel's card state (VAY-2205)", async () => {
    const state = {
      propertyId: PROPERTY_ID,
      providerAccount: { ready: true, cardCapabilityRevision: 7 },
      propertyReadinessRevision: 1,
      paymentSettings: { paymentsOn: true, cardChosen: true, currencyEligible: true },
      evidence: null,
      cardReady: true,
      prices: "current" as const,
    };
    const read = vi.fn(async (propertyId: string) => (propertyId === PROPERTY_ID ? state : null));
    const url = `/finance/platform/properties/${PROPERTY_ID}/online-card-execution-evidence`;
    const get = (path = url) =>
      app!.inject({ method: "GET", url: path, headers: { authorization: "Bearer valid" } });
    app = await testApp({ readOnlineCardExecutionState: read });
    expect((await get()).json()).toEqual(state);
    expect(read).toHaveBeenCalledWith(PROPERTY_ID);
    expect(
      (await get(`/finance/platform/properties/${EVIDENCE_ID}/online-card-execution-evidence`))
        .statusCode,
    ).toBe(404);
    expect(
      (await get("/finance/platform/properties/not-a-uuid/online-card-execution-evidence"))
        .statusCode,
    ).toBe(400);
    await app.close();
    app = await testApp({ readOnlineCardExecutionState: read }, { permissions: [] });
    expect((await get()).statusCode).toBe(403);
    await app.close();
    app = await testApp({});
    expect((await get()).statusCode).toBe(501);
  });

  it("offers no way to approve or withdraw card any more (VAY-2442)", async () => {
    // Even a repository that still has the writes gets no route to them.
    const accept = vi.fn();
    const revoke = vi.fn();
    app = await testApp({
      acceptOnlineCardExecutionEvidence: accept,
      revokeOnlineCardExecutionEvidence: revoke,
    });
    const post = (url: string) =>
      app!.inject({
        method: "POST",
        url,
        headers: { authorization: "Bearer valid" },
        payload: { commandId: PROPERTY_ID, idempotencyKey: EVIDENCE_ID },
      });
    const base = `/finance/platform/properties/${PROPERTY_ID}/online-card-execution-evidence`;
    expect((await post(base)).statusCode).toBe(404);
    expect((await post(`${base}/${EVIDENCE_ID}/revoke`)).statusCode).toBe(404);
    expect(accept).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});
