import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { describe, expect, it, vi } from "vitest";

import { FinanceRevenueEvidenceError } from "./domains/financeRevenueReadModel.js";
import { buildApp } from "./app.js";
import type { FinanceRevenueRoutesOptions } from "./routes/financeRevenue.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";

const propertyId = "11280000-0000-4000-8000-000000000001";
const otherProperty = "11280000-0000-4000-8000-000000000002";
const roomTypeId = "11280000-0000-4000-8000-000000000010";
const root = `/api/finance/properties/${propertyId}/financials/revenue`;
const zero = money("0.0000");
const metric = { value: zero, absoluteChange: zero, percentChange: null };
const response = {
  contractVersion: "pms-financials.v1",
  propertyId,
  currency: "EUR",
  timeZone: "Asia/Kolkata",
  generatedAt: "2026-08-04T14:00:00.000Z",
  sourceFreshness: { bookingRevenueThrough: "2026-08-03" },
  incompleteEvidence: [],
  summary: {
    grossRoom: { ...metric, value: money("1999999999999999.9998") },
    otaCommission: metric,
    netRoom: metric,
    upsell: metric,
    nights: { value: 0, absoluteChange: 0, percentChange: null },
    adr: metric,
    attachRate: { value: "0.0000", absoluteChange: "0.0000", percentChange: null },
  },
  channels: [{ channel: "direct", gross: zero, commission: zero, net: zero, share: "0.0000" }],
  directSources: [{ source: "email", revenue: zero, share: "0.0000" }],
  upsells: [{ ownership: "property", revenue: zero }],
  roomTypes: [{ roomTypeId, nights: 0, revenue: zero, adr: zero }],
};

describe("Financials revenue route", () => {
  it("returns a private scoped response for a strict inclusive range", async () => {
    const options = ports(),
      instance = await app(options);
    const result = await instance.inject({
      method: "GET",
      url: `${root}?from=2026-08-01&to=2026-08-03`,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(response);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers.vary).toContain("Authorization");
    expect(options.read.revenue).toHaveBeenCalledWith(propertyId, {
      from: "2026-08-01",
      to: "2026-08-03",
    });
    await instance.close();
  });

  it("rejects malformed property and query inputs before the reader", async () => {
    const options = ports(),
      instance = await app(options);
    for (const url of [
      `${root}?from=2026-08-01`,
      `${root}?from=2026-08-03&to=2026-08-01`,
      `${root}?from=2026-02-30&to=2026-03-01`,
      `${root}?from=2026-08-01&to=2026-08-03&secret=1`,
      "/api/finance/properties/not-a-uuid/financials/revenue?from=2026-08-01&to=2026-08-03",
    ])
      expect((await instance.inject({ method: "GET", url })).statusCode).toBe(400);
    expect(options.read.revenue).not.toHaveBeenCalled();
    await instance.close();
  });

  it("maps missing, unavailable, and unexpected reader outcomes without leaking details", async () => {
    for (const [value, status, code] of [
      [null, 404, "not_found"],
      [new FinanceRevenueEvidenceError("private detail"), 422, "evidence_unavailable"],
      [new Error("private detail"), 500, "finance_revenue_port_contract_violation"],
    ] as const) {
      const options = ports();
      options.read.revenue = vi.fn(async () => {
        if (value instanceof Error) throw value;
        return value;
      }) as never;
      const instance = await app(options),
        result = await instance.inject({
          method: "GET",
          url: `${root}?from=2026-08-01&to=2026-08-03`,
        });
      expect(result.statusCode).toBe(status);
      expect(result.json()).toEqual({ code });
      expect(result.body).not.toContain("private detail");
      await instance.close();
    }
  });

  it("rejects every authorization gap before validation or reader access", async () => {
    const valid = context();
    const unassigned = context();
    unassigned.membership.propertyAccess!.assignedPropertyIds = [];
    const denied: Array<[RequestContext | null, number]> = [
      [null, 401],
      [context({ permissions: [] }), 403],
      [context({ kind: "platform" }), 403],
      [context({ entitlements: [entitlement("module:financials")] }), 403],
      [
        context({
          entitlements: [
            entitlement("property-management", "suspended"),
            entitlement("module:financials"),
          ],
        }),
        403,
      ],
      [
        context({
          entitlements: [
            entitlement("property-management"),
            entitlement("module:financials", "suspended"),
          ],
        }),
        403,
      ],
      [context({ links: [] }), 403],
      [context({ links: [{ ...valid.linkedResources[0]!, relationship: "operator" }] }), 403],
    ];
    for (const [auth, status] of denied) {
      const options = ports(),
        instance = await app(options, auth),
        result = await instance.inject({
          method: "GET",
          url: `${root}?secret=1`,
        });
      expect(result.statusCode).toBe(status);
      expect(options.read.revenue).not.toHaveBeenCalled();
      await instance.close();
    }
    const options = ports(),
      instance = await app(options, unassigned);
    expect(
      (await instance.inject({ method: "GET", url: `${root}?from=2026-08-01&to=2026-08-03` }))
        .statusCode,
    ).toBe(403);
    expect(options.read.revenue).not.toHaveBeenCalled();
    await instance.close();
  });

  it("fails closed on cross-property access and tampered reader responses", async () => {
    let options = ports(),
      instance = await app(options),
      result = await instance.inject({
        method: "GET",
        url: `/api/finance/properties/${otherProperty}/financials/revenue?from=2026-08-01&to=2026-08-03`,
      });
    expect(result.statusCode).toBe(403);
    expect(options.read.revenue).not.toHaveBeenCalled();
    await instance.close();
    for (const tampered of [
      { ...response, propertyId: otherProperty },
      { ...response, channels: [{ ...response.channels[0]!, share: "1.0001" }] },
      { ...response, providerSecret: "no" },
      {
        ...response,
        incompleteEvidence: [{ code: "gap", count: 1, currency: "USD", amount: money("1.0000") }],
      },
    ]) {
      options = ports();
      options.read.revenue = vi.fn(async () => tampered) as never;
      instance = await app(options);
      result = await instance.inject({
        method: "GET",
        url: `${root}?from=2026-08-01&to=2026-08-03`,
      });
      expect(result.statusCode).toBe(500);
      expect(result.json()).toEqual({ code: "finance_revenue_port_contract_violation" });
      await instance.close();
    }
  });
});

function money(amount: string) {
  return { amount, currency: "EUR" };
}
function ports() {
  return {
    read: { revenue: vi.fn(async () => structuredClone(response)) },
  } as unknown as FinanceRevenueRoutesOptions;
}
// prettier-ignore
async function app(options: FinanceRevenueRoutesOptions, auth: RequestContext | null = context()) { const instance = buildApp({ logger: false, financeRevenue: { ...options, propertyAccessRepository: agencyPropertyAccessRepository } }); instance.decorateRequest("authContext", null); instance.addHook("onRequest", async (request) => { request.authContext = auth; }); return instance; }
// prettier-ignore
const resource = { product: "pms" as const, resourceType: "pms_property" as const, resourceId: propertyId }, entitlement = (key: string, status: ProductEntitlement["status"] = "active"): ProductEntitlement => ({ product: "pms", key, status, resource });
// prettier-ignore
const context = (overrides: { permissions?: PermissionKey[]; entitlements?: ProductEntitlement[]; links?: LinkedResource[]; kind?: "hotel_group" | "platform" } = {}): RequestContext => ({ actor: { internalUserId: "11280000-0000-4000-8000-000000000020", status: "active" }, selectedOrganization: { organizationId: "11280000-0000-4000-8000-000000000021", kind: overrides.kind ?? "hotel_group", status: "active" }, membership: { roleKey: "hotel_owner", status: "active", propertyAccess: { mode: "assigned", roleKey: "hotel_owner", accessOrigin: "agency", assignedPropertyIds: [propertyId] }, permissions: overrides.permissions ?? ["pms.finance.read"] }, entitlements: overrides.entitlements ?? [entitlement("property-management"), entitlement("module:financials")], linkedResources: overrides.links ?? [{ ...resource, relationship: "owner", status: "active" }, { product: "hotel_catalog", resourceType: "property", resourceId: propertyId, relationship: "owner", status: "active" }], locale: "en", currency: "EUR", audit: { requestId: "request-1", receivedAt: "2026-08-04T14:00:00Z", source: "api" } } as unknown as RequestContext);
