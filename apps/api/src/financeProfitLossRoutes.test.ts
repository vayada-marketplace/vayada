import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { describe, expect, it, vi } from "vitest";

import { FinanceProfitLossEvidenceError } from "./domains/financeProfitLossReadModel.js";
import { composeFinanceProfitLossResponse } from "./domains/financeProfitLossResponse.js";
import { buildApp } from "./app.js";
import type { FinanceProfitLossRoutesOptions } from "./routes/financeProfitLoss.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";

const propertyId = "11310000-0000-4000-8000-000000000001";
const otherProperty = "11310000-0000-4000-8000-000000000002";
const custom = "custom:11310000-0000-4000-8000-000000000003" as const;
const root = `/api/finance/properties/${propertyId}/financials/profit-loss`;
const response = composeFinanceProfitLossResponse({
  propertyId,
  currency: "EUR",
  timeZone: "Europe/Berlin",
  generatedAt: "2026-09-17T14:00:00.000Z",
  asOf: "2026-09-17",
  query: { year: 2026 },
  sourceFreshness: { financeExpensesAt: "2026-09-17T13:00:00.000Z" },
  categoryRows: [custom],
  roomRevenue: [],
  upsellRevenue: [],
  expenses: [],
});

describe("Financials profit and loss route", () => {
  it("returns a private property-scoped annual response", async () => {
    const options = ports(),
      manager = context();
    manager.linkedResources[0]!.relationship = "finance_manager";
    const instance = await app(options, manager);
    const result = await instance.inject({ method: "GET", url: `${root}?year=2026` });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(response);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers.vary).toContain("Authorization");
    expect(options.read.profitLoss).toHaveBeenCalledWith(propertyId, { year: 2026 });
    await instance.close();
  });

  it("rejects malformed property and query inputs before the reader", async () => {
    const options = ports(),
      instance = await app(options);
    for (const url of [
      root,
      `${root}?year=1000`,
      `${root}?year=2026&secret=1`,
      "/api/finance/properties/not-a-uuid/financials/profit-loss?year=2026",
    ])
      expect((await instance.inject({ method: "GET", url })).statusCode).toBe(400);
    expect(options.read.profitLoss).not.toHaveBeenCalled();
    await instance.close();
  });

  it("maps missing, unavailable, and unexpected reader outcomes without leaking details", async () => {
    for (const [value, status, code] of [
      [null, 404, "not_found"],
      [new FinanceProfitLossEvidenceError("private detail"), 422, "evidence_unavailable"],
      [new Error("private detail"), 500, "finance_profit_loss_port_contract_violation"],
    ] as const) {
      const options = ports();
      options.read.profitLoss = vi.fn(async () => {
        if (value instanceof Error) throw value;
        return value;
      }) as never;
      const instance = await app(options),
        result = await instance.inject({ method: "GET", url: `${root}?year=2026` });
      expect(result.statusCode).toBe(status);
      expect(result.json()).toEqual({ code });
      expect(result.body).not.toContain("private detail");
      await instance.close();
    }
  });

  it("rejects every authorization gap before query validation or reader access", async () => {
    const valid = context(),
      unassigned = context();
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
        result = await instance.inject({ method: "GET", url: `${root}?secret=1` });
      expect(result.statusCode).toBe(status);
      expect(options.read.profitLoss).not.toHaveBeenCalled();
      await instance.close();
    }
    const options = ports(),
      instance = await app(options, unassigned);
    expect((await instance.inject({ method: "GET", url: `${root}?year=2026` })).statusCode).toBe(
      403,
    );
    expect(options.read.profitLoss).not.toHaveBeenCalled();
    await instance.close();
  });

  it("fails closed on cross-property access and tampered reader responses", async () => {
    let options = ports(),
      instance = await app(options);
    expect(
      (
        await instance.inject({
          method: "GET",
          url: `/api/finance/properties/${otherProperty}/financials/profit-loss?year=2026`,
        })
      ).statusCode,
    ).toBe(403);
    expect(options.read.profitLoss).not.toHaveBeenCalled();
    await instance.close();
    for (const tampered of [
      { ...response, propertyId: otherProperty },
      {
        ...response,
        summary: {
          ...response.summary,
          netProfitYtd: { ...response.summary.netProfitYtd, value: money("1.0000") },
        },
      },
      { ...response, providerSecret: "no" },
      {
        ...response,
        months: response.months.map((month) => {
          const { [custom]: _, ...expenseCategories } = month.expenseCategories;
          return { ...month, expenseCategories };
        }),
      },
    ]) {
      options = ports();
      options.read.profitLoss = vi.fn(async () => tampered) as never;
      instance = await app(options);
      const result = await instance.inject({ method: "GET", url: `${root}?year=2026` });
      expect(result.statusCode).toBe(500);
      expect(result.json()).toEqual({ code: "finance_profit_loss_port_contract_violation" });
      await instance.close();
    }
  });
});

function money(amount: string) {
  return { amount, currency: "EUR" };
}
function ports() {
  return {
    read: {
      profitLoss: vi.fn(async () => ({
        response: structuredClone(response),
        categoryRows: [custom],
      })),
    },
  } as unknown as FinanceProfitLossRoutesOptions;
}
// prettier-ignore
async function app(options: FinanceProfitLossRoutesOptions, auth: RequestContext | null = context()) { const instance = buildApp({ logger: false, financeProfitLoss: { ...options, propertyAccessRepository: agencyPropertyAccessRepository } }); instance.decorateRequest("authContext", null); instance.addHook("onRequest", async (request) => { request.authContext = auth; }); return instance; }
// prettier-ignore
const resource = { product: "pms" as const, resourceType: "pms_property" as const, resourceId: propertyId }, entitlement = (key: string, status: ProductEntitlement["status"] = "active"): ProductEntitlement => ({ product: "pms", key, status, resource });
// prettier-ignore
const context = (overrides: { permissions?: PermissionKey[]; entitlements?: ProductEntitlement[]; links?: LinkedResource[]; kind?: "hotel_group" | "platform" } = {}): RequestContext => ({ actor: { internalUserId: "11310000-0000-4000-8000-000000000020", status: "active" }, selectedOrganization: { organizationId: "11310000-0000-4000-8000-000000000021", kind: overrides.kind ?? "hotel_group", status: "active" }, membership: { roleKey: "hotel_owner", status: "active", propertyAccess: { mode: "assigned", roleKey: "hotel_owner", accessOrigin: "agency", assignedPropertyIds: [propertyId] }, permissions: overrides.permissions ?? ["pms.finance.read"] }, entitlements: overrides.entitlements ?? [entitlement("property-management"), entitlement("module:financials")], linkedResources: overrides.links ?? [{ ...resource, relationship: "owner", status: "active" }, { product: "hotel_catalog", resourceType: "property", resourceId: propertyId, relationship: "owner", status: "active" }], locale: "en", currency: "EUR", audit: { requestId: "request-1", receivedAt: "2026-09-17T14:00:00Z", source: "api" } } as unknown as RequestContext);
