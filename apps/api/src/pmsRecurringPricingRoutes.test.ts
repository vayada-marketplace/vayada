import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PMS_RECURRING_PRICING_CONTRACT_VERSION,
  parsePmsDecimalAmount,
  parsePmsPricingCurrency,
  parsePmsRecurringMonthDay,
  type PmsRecurringPricingSourceSnapshot,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsRecurringPricingRoutes,
  type PmsRecurringPricingRoutesOptions,
} from "./routes/pmsRecurringPricing.js";

const propertyId = "72000000-0000-4000-8000-000000000001";
const otherPropertyId = "72000000-0000-4000-8000-000000000002";
const sourceId = "72000000-0000-4000-8000-000000000003";
const roomTypeId = "72000000-0000-4000-8000-000000000004";
const planId = "72000000-0000-4000-8000-000000000005";
const organizationId = "72000000-0000-4000-8000-000000000006";
const actorUserId = "72000000-0000-4000-8000-000000000007";
const now = "2026-08-03T12:00:00.000Z";
const eur = parsePmsPricingCurrency("EUR")!;
const amount = parsePmsDecimalAmount("175.25")!;
const monthDayStart = parsePmsRecurringMonthDay("06-01")!;
const monthDayEnd = parsePmsRecurringMonthDay("09-30")!;

type AuthOptions = {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
  organizationKind?: "hotel_group" | "customer";
};

type FakePorts = PmsRecurringPricingRoutesOptions & { calls: { reads: Array<readonly unknown[]> } };

function sourceBase(
  command: {
    propertyId: string;
    sourceId: string;
    expectedSourceRevision: number;
    expectedPricingCurrencyRevision: number;
  },
  configuredState: "active" | "disabled" = "active",
  lifecycle: "active" | "disabled" | "invalid" = configuredState,
) {
  return {
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId: command.propertyId,
    sourceId: command.sourceId,
    sourceRevision: command.expectedSourceRevision + 1,
    pricingCurrencyRevision: command.expectedPricingCurrencyRevision,
    currency: eur,
    configuredState,
    validation:
      lifecycle === "invalid"
        ? {
            state: "invalid" as const,
            validationRevision: 1,
            validatedAt: now,
            reasons: [{ code: "dependency_unavailable" as const }],
          }
        : { state: "valid" as const, validationRevision: 1, validatedAt: now },
    lifecycle,
    materializationRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function seasonSnapshot(
  overrides: { propertyId?: string; sourceId?: string; sourceRevision?: number } = {},
): PmsRecurringPricingSourceSnapshot {
  return {
    ...sourceBase({
      propertyId: overrides.propertyId ?? propertyId,
      sourceId: overrides.sourceId ?? sourceId,
      expectedSourceRevision: (overrides.sourceRevision ?? 1) - 1,
      expectedPricingCurrencyRevision: 1,
    }),
    sourceKind: "season",
    name: "Summer",
    startMonthDay: monthDayStart,
    endMonthDay: monthDayEnd,
    roomPrices: [
      {
        roomTypeId,
        roomFactsRevision: 2,
        flexibleRatePlanId: planId,
        flexibleRatePlanRevision: 3,
        amountDecimal: amount,
      },
    ],
  };
}

function fakePorts(overrides: { responsePropertyId?: string } = {}): FakePorts {
  const responsePropertyId = overrides.responsePropertyId;
  const calls: FakePorts["calls"] = { reads: [] };
  return {
    calls,
    readPort: {
      async getRecurringPricingSource(requestPropertyId, requestedSourceId) {
        calls.reads.push(["source", requestPropertyId, requestedSourceId]);
        return seasonSnapshot({
          propertyId: responsePropertyId ?? requestPropertyId,
          sourceId: requestedSourceId,
        });
      },
      async listRecurringPricingSources(requestPropertyId) {
        calls.reads.push(["sources", requestPropertyId]);
        return [seasonSnapshot({ propertyId: responsePropertyId ?? requestPropertyId })];
      },
      async getRecurringPricingBookingEvidence(requestPropertyId) {
        calls.reads.push(["evidence", requestPropertyId]);
        const source = seasonSnapshot({ propertyId: responsePropertyId ?? requestPropertyId });
        return {
          contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
          propertyId: responsePropertyId ?? requestPropertyId,
          pricingCurrencyRevision: 1,
          optionalPricingAggregateRevision: 1,
          currency: eur,
          sources: [source],
          capturedAt: now,
        };
      },
    },
  };
}

function entitlement(resourceId = propertyId): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status: "active",
    resource: { product: "pms", resourceType: "pms_property", resourceId },
  };
}

function link(relationship: LinkedResource["relationship"] = "operator"): LinkedResource {
  return {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
    relationship,
    status: "active",
  };
}

async function testApp(ports: FakePorts, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: {
        organizationId,
        kind: auth.organizationKind ?? "hotel_group",
      },
      membership: {
        permissions: auth.permissions ?? ["pms.operations.read", "pms.operations.manage"],
      },
      linkedResources: auth.links ?? [link()],
      entitlements: auth.entitlements ?? [entitlement()],
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: now,
      },
    } as RequestContext;
  });
  await app.register(registerPmsRecurringPricingRoutes, ports);
  return app;
}

function headers() {
  return { authorization: "Bearer valid-token" };
}

describe("PMS recurring-pricing routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("reads exact-property sources and Booking evidence while rejecting escaped port scope", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const list = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring`,
      headers: headers(),
    });
    const one = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}`,
      headers: headers(),
    });
    const evidence = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring-booking-evidence`,
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    expect(one.statusCode).toBe(200);
    expect(evidence.statusCode).toBe(200);
    expect(evidence.body).toMatchObject({
      propertyId,
      pricingCurrencyRevision: 1,
      optionalPricingAggregateRevision: 1,
      sources: [{ sourceId, lifecycle: "active" }],
    });
    await app.close();

    const escaped = fakePorts({ responsePropertyId: otherPropertyId });
    app = await testApp(escaped);
    const invalid = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring-booking-evidence`,
      headers: headers(),
    });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).toEqual({ code: "pms_recurring_pricing_port_contract_violation" });
  });

  it("authorizes before every port call", async () => {
    const ports = fakePorts();
    app = await testApp(ports, { links: [link("front_desk")] });
    const denied = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}`,
      headers: headers(),
    });
    expect(denied.statusCode).toBe(403);
    expect(ports.calls.reads).toEqual([]);
  });

  it("requires the read permission, active entitlement, linked property, and hotel scope", async () => {
    const scenarios: AuthOptions[] = [
      { permissions: ["pms.operations.manage"] },
      { entitlements: [] },
      { links: [] },
      { organizationKind: "customer" },
    ];
    for (const auth of scenarios) {
      const ports = fakePorts();
      app = await testApp(ports, auth);
      const response = await injectJson(app, {
        method: "GET",
        url: `/properties/${propertyId}/pricing-source/recurring`,
        headers: headers(),
      });
      expect(response.statusCode).toBe(403);
      expect(ports.calls.reads).toEqual([]);
      await app.close();
      app = null;
    }
  });
});
