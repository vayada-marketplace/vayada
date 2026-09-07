import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  FinanceAffiliateCommissionCommand,
  FinanceAffiliateCommissionRepository,
  FinanceAffiliateCommissionResult,
  FinanceAffiliateCommissionView,
} from "@vayada/domain-finance";
import type { MarketplaceAffiliateAdminRecord } from "@vayada/domain-marketplace";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerFinanceAffiliateCommissionRoutes,
  type FinanceAffiliateCommissionRoutesOptions,
} from "./routes/financeAffiliateCommissions.js";

const propertyId = "12780000-0000-4000-8000-000000000101";
const otherPropertyId = "12780000-0000-4000-8000-000000000102";
const actorUserId = "12780000-0000-4000-8000-000000000103";
const affiliateId = "aff_vay_1278";
const now = "2026-08-13T21:00:00.000Z";

type AuthOptions = {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};

describe("Finance affiliate commission routes", () => {
  const apps: Array<Awaited<ReturnType<typeof testApp>>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it.each(["GET", "PATCH"] as const)(
    "retires %s on both commission routes without reading or writing rules",
    async (method) => {
      const ports = fakePorts();
      const app = await testApp(ports);
      apps.push(app);
      for (const path of ["affiliate-commission", `affiliates/${affiliateId}/commission`]) {
        const response = await app.inject({
          method,
          url: `/api/finance/properties/${propertyId}/${path}`,
          headers: authHeader,
          ...(method === "PATCH"
            ? { payload: { commandId: "retired", idempotencyKey: "retired", percentageRate: "8" } }
            : {}),
        });
        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ code: "affiliate_commission_configuration_retired" });
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(ports.calls.get).toEqual([]);
      expect(ports.calls.set).toEqual([]);
      expect(ports.calls.scope).toEqual([]);
    },
  );

  it.each([
    {
      name: "without authentication",
      headers: {},
      auth: {},
      status: 401,
      code: "unauthenticated",
      financeAccess: "missing" as const,
    },
    {
      name: "with invalid authentication",
      headers: { authorization: "Bearer invalid-token" },
      auth: {},
      status: 401,
      code: "unauthenticated",
      financeAccess: "missing" as const,
    },
    {
      name: "without a property link",
      headers: authHeader,
      auth: { links: [] },
      status: 403,
      code: "missing_resource_access",
      financeAccess: "active" as const,
    },
    {
      name: "without permission",
      headers: authHeader,
      auth: { permissions: ["pms.finance.read" as PermissionKey] },
      status: 403,
      code: "missing_permission",
      financeAccess: "missing" as const,
    },
    {
      name: "without entitlement",
      headers: authHeader,
      auth: { entitlements: [] },
      status: 403,
      code: "missing_entitlement",
      financeAccess: "missing" as const,
    },
    {
      name: "with inactive entitlement",
      headers: authHeader,
      auth: { entitlements: [] },
      status: 403,
      code: "inactive_entitlement",
      financeAccess: "inactive" as const,
    },
    {
      name: "for another property",
      headers: authHeader,
      auth: { links: [propertyLink(otherPropertyId)] },
      status: 403,
      code: "missing_resource_access",
      financeAccess: "active" as const,
    },
  ])("denies commission reads $name", async ({ headers, auth, status, code, financeAccess }) => {
    const ports = fakePorts({ financeAccess });
    const app = await testApp(ports, auth);
    apps.push(app);
    for (const method of ["GET", "PATCH"] as const) {
      for (const path of ["affiliate-commission", `affiliates/${affiliateId}/commission`]) {
        const response = await injectJson<{ code: string }>(app, {
          method,
          url: `/api/finance/properties/${propertyId}/${path}`,
          headers,
        });
        expect(response.statusCode).toBe(status);
        expect(response.body.code).toBe(code);
      }
    }
    expect(ports.calls.get).toEqual([]);
    expect(ports.calls.set).toEqual([]);
    expect(ports.calls.scope).toEqual([]);
  });

  it("accepts the PMS property-management entitlement", async () => {
    const ports = fakePorts({ financeAccess: "missing" });
    const app = await testApp(ports, {
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/finance/properties/${propertyId}/affiliate-commission`,
      headers: authHeader,
    });
    expect(response.statusCode).toBe(410);
    expect(ports.calls.financeAccess).toEqual([]);
  });

  it("reads active Booking Finance access from the Finance-owned store", async () => {
    const ports = fakePorts({ financeAccess: "active" });
    const app = await testApp(ports, { entitlements: [] });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/finance/properties/${propertyId}/affiliate-commission`,
      headers: authHeader,
    });
    expect(response.statusCode).toBe(410);
    expect(ports.calls.financeAccess).toEqual([[propertyId, "org-vay-1278"]]);
  });
});

type FakePorts = FinanceAffiliateCommissionRoutesOptions & {
  calls: {
    get: unknown[];
    set: FinanceAffiliateCommissionCommand[];
    scope: unknown[];
    financeAccess: unknown[];
  };
};

function fakePorts(
  options: {
    result?: FinanceAffiliateCommissionResult;
    affiliate?: MarketplaceAffiliateAdminRecord | null;
    financeAccess?: "active" | "inactive" | "missing";
  } = {},
): FakePorts {
  const calls: FakePorts["calls"] = { get: [], set: [], scope: [], financeAccess: [] };
  return {
    calls,
    repository: {
      async getCommission(...input) {
        calls.get.push(input);
        return commissionView(input[1] ?? null);
      },
      async setCommission(command) {
        calls.set.push(command);
        return (
          options.result ?? {
            outcome: "applied",
            commandId: command.commandId,
            commission: commissionView(command.affiliateId),
          }
        );
      },
      async getBookingFinanceAccess(...input) {
        calls.financeAccess.push(input);
        return options.financeAccess ?? "active";
      },
    } satisfies FinanceAffiliateCommissionRepository,
    affiliateScope: {
      async getAffiliate(...input) {
        calls.scope.push(input);
        return options.affiliate === undefined ? affiliateRecord() : options.affiliate;
      },
    },
    now: () => new Date(now),
  };
}

async function testApp(ports: FakePorts, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId: "org-vay-1278", kind: "hotel_group" },
      membership: { permissions: auth.permissions ?? ["pms.finance.manage"] },
      entitlements: auth.entitlements ?? [pmsEntitlement()],
      linkedResources: auth.links ?? [propertyLink(propertyId)],
    } as RequestContext;
  });
  await app.register(registerFinanceAffiliateCommissionRoutes, {
    prefix: "/api/finance",
    ...ports,
  });
  return app;
}

function commissionView(targetAffiliateId: string | null): FinanceAffiliateCommissionView {
  return {
    contractVersion: "finance-affiliate-commission.v1",
    propertyId,
    affiliateId: targetAffiliateId,
    defaultPercentageRate: "7.5",
    overridePercentageRate: targetAffiliateId ? "12" : null,
    effectivePercentageRate: targetAffiliateId ? "12" : "7.5",
    updatedAt: now,
  };
}

function affiliateRecord(): MarketplaceAffiliateAdminRecord {
  return {
    contractVersion: "marketplace-affiliate-admin.v1",
    affiliateId,
    propertyId,
    referralCode: "VAY1278",
    displayName: "Ada Affiliate",
    contactEmail: "ada@example.test",
    socialMedia: null,
    affiliateType: "creator",
    lifecycleStatus: "approved",
    applicationSource: "collaboration",
    appliedAt: now,
    updatedAt: now,
  };
}

function pmsEntitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return { product: "pms", key: "property-management", status };
}

function propertyLink(resourceId: string): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId,
    relationship: "finance_manager",
    status: "active",
  };
}

const authHeader = { authorization: "Bearer valid-token" };
