import type { PoolClient } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { lockFinancePricingAcceptanceTerms } from "./financePricingAcceptanceTerms.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
const scope = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  authorityRevision: "owner-1",
};
let entitlement: Record<string, unknown>, commission: Record<string, unknown>;
let now: Date, missing: string | null, events: string[];
const query = vi.fn(async (sql: string, values?: unknown[]) => {
  if (sql.includes("hotel_catalog.properties")) {
    events.push("property");
    return { rows: [{}], rowCount: 1 };
  }
  if (sql.includes("finance.billing_entitlements")) {
    expect(sql).toContain("organization_id=$2");
    expect(sql).toContain("FOR SHARE");
    expect(values).toEqual([scope.propertyId, scope.organizationId]);
    events.push("entitlement");
    return { rows: missing === "entitlement" ? [] : [entitlement], rowCount: 1 };
  }
  if (sql.includes("finance.commission_rules")) {
    expect(sql).toContain("organization_id IS NULL OR organization_id=$2");
    expect(sql).toContain("FOR SHARE");
    expect(sql).toContain("source_rule_id='onboarding-booking:'||$1::text");
    events.push("commission");
    return { rows: missing === "commission" ? [] : [commission], rowCount: 1 };
  }
  expect(sql).toBe("SELECT clock_timestamp() AS now");
  events.push("clock");
  return { rows: [{ now }], rowCount: 1 };
});
const client = { query } as unknown as PoolClient;
beforeEach(() => {
  vi.clearAllMocks();
  missing = null;
  events = [];
  now = new Date("2026-09-14T12:00:00Z");
  entitlement = {
    plan_key: "commission",
    billing_status: "active",
    provider_subscription_status: null,
    entitlement_metadata: { planSelectedAt: "2026-09-01T00:00:00Z" },
    starts_at: null,
    expires_at: null,
    updated_at: new Date("2026-09-01T00:00:00Z"),
  };
  commission = {
    percentage_rate: "5.0000",
    rule_metadata: { source: "onboarding", bookingEngineFeePercent: 5 },
    starts_at: new Date("2026-09-01T00:00:00Z"),
    ends_at: null,
    updated_at: new Date("2026-09-02T00:00:00Z"),
    status: "active",
    commission_type: "percentage",
  };
  vi.mocked(lockPublicPricingAuthority).mockImplementation(async () => {
    events.push("authority");
    return scope;
  });
});
it("captures actual onboarding terms in the caller transaction, retaining owner-defined absent optional fees", async () => {
  expect(await lockFinancePricingAcceptanceTerms(client, "hotel")).toEqual({
    scope,
    billingPlanSnapshot: "commission",
    commissionTermsSnapshot: {
      bookingEngineFeePercent: 5,
      channelManagerFeePercent: 5,
      affiliatePlatformFeePercent: 0,
      financeConfigUpdatedAt: "2026-09-02T00:00:00.000Z",
    },
    financeTermsCapturedAt: now.toISOString(),
    validUntil: null,
  });
  expect(events).toEqual([
    "authority",
    "property",
    "entitlement",
    "commission",
    "authority",
    "clock",
  ]);
  expect(
    query.mock.calls.some(([sql]) => /BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE finance/.test(sql)),
  ).toBe(false);
});
it("keeps fixed-plan nominal fees and explicit optional zero/string percentages", async () => {
  Object.assign(entitlement, {
    plan_key: "fixed",
    provider_subscription_status: "trialing",
    entitlement_metadata: {},
  });
  commission.rule_metadata = { channelManagerFeePercent: 0, affiliatePlatformFeePercent: "2.5" };
  const result = await lockFinancePricingAcceptanceTerms(client, "hotel");
  expect(result?.billingPlanSnapshot).toBe("fixed");
  expect(result?.commissionTermsSnapshot).toMatchObject({
    bookingEngineFeePercent: 5,
    channelManagerFeePercent: 0,
    affiliatePlatformFeePercent: 2.5,
  });
});
it.each([null, "", "bad", -1, 101, true, [], {}, undefined])(
  "rejects malformed present optional fee %j",
  async (value) => {
    commission.rule_metadata = { affiliatePlatformFeePercent: value };
    expect(await lockFinancePricingAcceptanceTerms(client, "hotel")).toBeNull();
  },
);
it.each([
  { plan_key: "unknown" },
  { billing_status: "expired" },
  { entitlement_metadata: {} },
  { entitlement_metadata: { planSelectedAt: "bad" } },
  { plan_key: "fixed", provider_subscription_status: "past_due" },
  { expires_at: new Date("2026-09-14T12:00:00Z") },
  { starts_at: new Date("2026-09-15T00:00:00Z") },
  { updated_at: new Date("invalid") },
  { updated_at: new Date("2026-09-15T00:00:00Z") },
])("rejects unavailable or invalid billing evidence %j", async (patch) => {
  Object.assign(entitlement, patch);
  expect(await lockFinancePricingAcceptanceTerms(client, "hotel")).toBeNull();
});
it.each([
  { percentage_rate: 7 },
  { rule_metadata: null },
  { status: "inactive" },
  { commission_type: "fixed" },
  { ends_at: new Date("2026-09-14T12:00:00Z") },
  { starts_at: null },
])("rejects invalid current commission evidence %j", async (patch) => {
  Object.assign(commission, patch);
  expect(await lockFinancePricingAcceptanceTerms(client, "hotel")).toBeNull();
});
it.each(["entitlement", "commission"])("never manufactures a missing %s", async (value) => {
  missing = value;
  expect(await lockFinancePricingAcceptanceTerms(client, "hotel")).toBeNull();
});
it("rejects missing/revoked/changed public scope without accepting caller-posted property IDs", async () => {
  vi.mocked(lockPublicPricingAuthority).mockResolvedValueOnce(null);
  expect(
    await lockFinancePricingAcceptanceTerms(client, { propertyId: scope.propertyId }),
  ).toBeNull();
  expect(query).not.toHaveBeenCalled();
  vi.mocked(lockPublicPricingAuthority)
    .mockResolvedValueOnce(scope)
    .mockResolvedValueOnce({ ...scope, authorityRevision: "owner-2" });
  expect(await lockFinancePricingAcceptanceTerms(client, "hotel")).toBeNull();
  expect(events).not.toContain("clock");
});
it("checks expiry after authority waits and returns the earliest validity deadline", async () => {
  entitlement.expires_at = new Date("2026-09-14T12:05:00Z");
  commission.ends_at = new Date("2026-09-14T12:04:00Z");
  expect((await lockFinancePricingAcceptanceTerms(client, "hotel"))?.validUntil).toBe(
    "2026-09-14T12:04:00.000Z",
  );
  vi.mocked(lockPublicPricingAuthority)
    .mockResolvedValueOnce(scope)
    .mockImplementationOnce(async () => {
      now = new Date("2026-09-14T12:04:00Z");
      return scope;
    });
  expect(await lockFinancePricingAcceptanceTerms(client, "hotel")).toBeNull();
});
