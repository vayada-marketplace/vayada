import type { StripeSubscriptionSnapshot } from "@vayada/domain-finance";
import type { RoomInventorySnapshot } from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import {
  adoptLegacyFixedPlanSubscription,
  clearStaleLegacyBillingReference,
  createPgLegacyAdoptionStore,
  type LegacyAdoptionEntitlement,
  type LegacyAdoptionStore,
  type LegacyAdoptionStripe,
  type LegacySubscriptionInspection,
} from "./financeLegacySubscriptionAdoption.js";

const PROPERTY = "f3000000-0000-4000-8000-000000001362";
const ORGANIZATION = "f2000000-0000-4000-8000-000000001362";
const NOW = new Date("2026-10-20T10:00:00.000Z");

describe("Legacy fixed-plan subscription adoption", () => {
  it("dry-runs without any Stripe or entitlement write", async () => {
    const fixture = setup();

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: false },
      fixture.dependencies,
    );

    expect(report).toMatchObject({
      outcome: "would_adopt",
      reasons: [],
      activeRoomCount: 3,
      stripe: { status: "active", amountMinor: 3_500, currency: "EUR" },
      entitlementBefore: { planKey: "commission", billingStatus: "suspended" },
    });
    expect(fixture.stripe.markAdopted).not.toHaveBeenCalled();
    expect(fixture.store.adopt).not.toHaveBeenCalled();
  });

  it("adopts in place: metadata only on Stripe, then the fixed entitlement", async () => {
    const fixture = setup();

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.outcome).toBe("adopted");
    expect(report.bookabilityRefreshed).toBe(true);
    expect(fixture.stripe.markAdopted).toHaveBeenCalledWith({
      subscriptionId: "sub_legacy",
      propertyId: PROPERTY,
      organizationId: ORGANIZATION,
      productId: "prod_legacy",
      idempotencyKey: `legacy-adoption:${PROPERTY}:sub_legacy:v2`,
    });
    // The entitlement is written from a fresh read, not the idempotent POST reply.
    expect(fixture.stripe.inspectLegacySubscription).toHaveBeenCalledTimes(2);
    expect(fixture.store.adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: PROPERTY,
        organizationId: ORGANIZATION,
        activeRoomCount: 3,
        adoptedAt: NOW.toISOString(),
        snapshot: expect.objectContaining({ amountMinor: 3_500, retainedLegacyPrice: true }),
      }),
    );
    expect(fixture.refreshPublicBookability).toHaveBeenCalledWith(PROPERTY);
  });

  it("is idempotent: an adopted hotel is reported and left alone", async () => {
    const fixture = setup({
      planKey: "fixed",
      billingStatus: "active",
      subscriptionRef: "sub_legacy",
      metadata: { legacyAdoptedAt: NOW.toISOString(), providerReentryRequired: false },
    });

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.outcome).toBe("already_adopted");
    expect(fixture.stripe.inspectLegacySubscription).not.toHaveBeenCalled();
    expect(fixture.store.adopt).not.toHaveBeenCalled();
  });

  it("stores the live state when the idempotent write replays a stale reply", async () => {
    const fixture = setup();
    fixture.afterMark.snapshot = {
      ...adoptedSnapshot(),
      status: "past_due",
      currentPeriodEnd: "2026-11-30T00:00:00.000Z",
    };

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.stripe).toMatchObject({
      status: "past_due",
      currentPeriodEnd: "2026-11-30T00:00:00.000Z",
    });
    expect(fixture.store.adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({ status: "past_due" }),
      }),
    );
  });

  it("finishes the record when a webhook bound the subscription before the entitlement write", async () => {
    const fixture = setup({
      planKey: "fixed",
      billingStatus: "active",
      subscriptionRef: "sub_legacy",
      metadata: { providerReentryRequired: true, legacyPlan: "fixed" },
    });
    fixture.inspection.adoptionMarker = "v1";
    fixture.inspection.snapshot = adoptedSnapshot();

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.outcome).toBe("adopted");
    expect(fixture.store.adopt).toHaveBeenCalledTimes(1);
  });

  it("does not lift a suspension that is not about billing", async () => {
    const fixture = setup({ commissionRuleActive: false });

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report).toMatchObject({ outcome: "refused", reasons: ["commission_rule_not_active"] });
    expect(fixture.stripe.markAdopted).not.toHaveBeenCalled();
    expect(fixture.store.adopt).not.toHaveBeenCalled();
  });

  it("repairs a run whose Stripe write succeeded but whose entitlement write did not", async () => {
    const fixture = setup();
    fixture.inspection.adoptionMarker = "v1";
    fixture.inspection.snapshot = adoptedSnapshot();

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.outcome).toBe("adopted");
    expect(fixture.stripe.markAdopted).toHaveBeenCalledTimes(1);
    expect(fixture.store.adopt).toHaveBeenCalledTimes(1);
  });

  it("reports a failed bookability refresh after the committed write", async () => {
    const fixture = setup();
    fixture.refreshPublicBookability.mockRejectedValueOnce(new Error("publisher down"));

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );
    expect(report).toMatchObject({
      outcome: "adopted",
      bookabilityRefreshed: false,
      reasons: ["bookability_refresh_failed:publisher down"],
    });

    fixture.entitlement.planKey = "fixed";
    fixture.entitlement.subscriptionRef = "sub_legacy";
    fixture.entitlement.metadata = {
      legacyAdoptedAt: NOW.toISOString(),
      providerReentryRequired: false,
    };
    const rerun = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );
    expect(rerun).toMatchObject({ outcome: "already_adopted", bookabilityRefreshed: true });
    expect(fixture.store.adopt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stripe_hotel_id_mismatch", { hotelId: "other-hotel" }],
    ["stripe_payment_kind_mismatch", { paymentKind: "booking" }],
    ["stripe_price_not_flat_30d", { flatThirtyDayPrice: false }],
    ["stripe_product_missing", { productId: null }],
    ["stripe_status_canceled", { snapshot: { ...legacySnapshot(), status: "canceled" } }],
    ["stripe_period_end_missing", { snapshot: { ...legacySnapshot(), currentPeriodEnd: null } }],
    [
      "within_24h_of_period_end",
      { snapshot: { ...legacySnapshot(), currentPeriodEnd: "2026-10-21T09:00:00.000Z" } },
    ],
    [
      "stripe_adopted_for_other_property",
      { adoptionMarker: "v1", snapshot: { ...adoptedSnapshot(), propertyId: "other" } },
    ],
  ] as const)("refuses %s without writing", async (reason, override) => {
    const fixture = setup();
    Object.assign(fixture.inspection, override);

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.outcome).toBe("refused");
    expect(report.reasons).toContain(reason);
    expect(fixture.stripe.markAdopted).not.toHaveBeenCalled();
    expect(fixture.store.adopt).not.toHaveBeenCalled();
  });

  it("refuses a hotel whose organization is not active or whose rooms are unknown", async () => {
    const fixture = setup({ organizationStatus: "archived" });
    fixture.roomInventory.getRoomInventorySnapshot.mockResolvedValue(null);

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.reasons).toEqual(["organization_not_active", "room_inventory_missing"]);
    expect(fixture.stripe.markAdopted).not.toHaveBeenCalled();
  });

  it("refuses an entitlement already bound to another subscription", async () => {
    const fixture = setup({ subscriptionRef: "sub_other" });

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.reasons).toContain("entitlement_bound_to_other_subscription");
    expect(fixture.store.adopt).not.toHaveBeenCalled();
  });

  it.each([
    ["became unpaid", { status: "unpaid" }],
    ["renewed into the guard", { currentPeriodEnd: "2026-10-21T09:00:00.000Z" }],
  ] as const)(
    "does not write the entitlement when the re-read subscription %s",
    async (_case, override) => {
      const fixture = setup();
      fixture.afterMark.snapshot = { ...adoptedSnapshot(), ...override };

      await expect(
        adoptLegacyFixedPlanSubscription(
          { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
          fixture.dependencies,
        ),
      ).rejects.toThrow("entitlement unchanged");
      expect(fixture.store.adopt).not.toHaveBeenCalled();
    },
  );

  it("does not write the entitlement when the marked subscription fails verification", async () => {
    const fixture = setup();
    fixture.afterMark.snapshot = { ...adoptedSnapshot(), retainedLegacyPrice: false };

    await expect(
      adoptLegacyFixedPlanSubscription(
        { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
        fixture.dependencies,
      ),
    ).rejects.toThrow("entitlement unchanged");
    expect(fixture.store.adopt).not.toHaveBeenCalled();
  });

  it("clears a stale legacy reference only when Stripe holds no live subscription", async () => {
    const fixture = setup();
    fixture.stripe.findLegacySubscriptionsForHotel.mockResolvedValue([
      { subscriptionId: "sub_old", status: "canceled" },
      { subscriptionId: "sub_expired", status: "incomplete_expired" },
      { subscriptionId: "sub_live", status: "past_due" },
      { subscriptionId: "sub_pending", status: "incomplete" },
      { subscriptionId: "sub_unpaid", status: "unpaid" },
    ]);

    const refused = await clearStaleLegacyBillingReference(
      { propertyId: PROPERTY, apply: true },
      fixture.dependencies,
    );
    expect(refused.outcome).toBe("refused");
    expect(refused.reasons).toEqual([
      "live_subscription_exists:sub_live",
      "live_subscription_exists:sub_pending",
      "live_subscription_exists:sub_unpaid",
    ]);
    expect(fixture.store.clearStaleReference).not.toHaveBeenCalled();

    fixture.stripe.findLegacySubscriptionsForHotel.mockResolvedValue([
      { subscriptionId: "sub_old", status: "canceled" },
    ]);
    const dryRun = await clearStaleLegacyBillingReference(
      { propertyId: PROPERTY, apply: false },
      fixture.dependencies,
    );
    expect(dryRun.outcome).toBe("would_clear");
    expect(fixture.store.clearStaleReference).not.toHaveBeenCalled();

    const cleared = await clearStaleLegacyBillingReference(
      { propertyId: PROPERTY, apply: true },
      fixture.dependencies,
    );
    expect(cleared.outcome).toBe("cleared");
    expect(fixture.store.clearStaleReference).toHaveBeenCalledWith({
      propertyId: PROPERTY,
      organizationId: ORGANIZATION,
      clearedAt: NOW.toISOString(),
    });
  });

  it("refuses to clear a reference that is not a stale legacy one", async () => {
    const fixture = setup({ billingStatus: "active", metadata: {} });

    const report = await clearStaleLegacyBillingReference(
      { propertyId: PROPERTY, apply: true },
      fixture.dependencies,
    );

    expect(report.outcome).toBe("refused");
    expect(report.reasons).toEqual([
      "not_a_stale_legacy_reference",
      "legacy_plan_not_commission",
      "entitlement_not_suspended",
    ]);
  });

  it("refuses to clear a hotel that is also suspended for another reason", async () => {
    const legacyFixed = setup({ metadata: { providerReentryRequired: true, legacyPlan: "fixed" } });
    const ruleInactive = setup({ commissionRuleActive: false });

    const fixedPlan = await clearStaleLegacyBillingReference(
      { propertyId: PROPERTY, apply: true },
      legacyFixed.dependencies,
    );
    const noRule = await clearStaleLegacyBillingReference(
      { propertyId: PROPERTY, apply: true },
      ruleInactive.dependencies,
    );

    expect(fixedPlan.reasons).toEqual(["legacy_plan_not_commission"]);
    expect(noRule.reasons).toEqual(["commission_rule_not_active"]);
    expect(legacyFixed.store.clearStaleReference).not.toHaveBeenCalled();
    expect(ruleInactive.store.clearStaleReference).not.toHaveBeenCalled();
  });

  it("reports an already cleared hotel and refreshes bookability on apply", async () => {
    const fixture = setup({
      billingStatus: "active",
      metadata: {
        providerReentryRequired: false,
        legacyPlan: "commission",
        legacyStaleReferenceClearedAt: NOW.toISOString(),
      },
    });

    const report = await clearStaleLegacyBillingReference(
      { propertyId: PROPERTY, apply: true },
      fixture.dependencies,
    );

    expect(report).toMatchObject({ outcome: "already_cleared", bookabilityRefreshed: true });
    expect(fixture.stripe.findLegacySubscriptionsForHotel).not.toHaveBeenCalled();
    expect(fixture.store.clearStaleReference).not.toHaveBeenCalled();
  });

  it("writes the adopted entitlement with the retained amount and an adoption event marker", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const store = createPgLegacyAdoptionStore({ query });

    await expect(
      store.adopt({
        propertyId: PROPERTY,
        organizationId: ORGANIZATION,
        snapshot: adoptedSnapshot(),
        activeRoomCount: 3,
        adoptedAt: NOW.toISOString(),
      }),
    ).resolves.toBe(true);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("plan_key = 'fixed'");
    expect(sql).toContain("billing_subscription_ref IS NULL");
    expect(sql).toContain("GREATEST(");
    expect(sql).toContain("billing_status = 'active'");
    expect(values.slice(0, 5)).toEqual([
      PROPERTY,
      ORGANIZATION,
      "active",
      "cus_legacy",
      "sub_legacy",
    ]);
    expect(values[8]).toBe(3_500);
    expect(values[9]).toBe("EUR");
    expect(values[10]).toBe(3);
    expect(JSON.parse(String(values[12]))).toMatchObject({
      planSelectedBy: "legacy-adoption",
      providerReentryRequired: false,
    });
    expect(values[13]).toBe("legacy-adoption:sub_legacy");

    await store.clearStaleReference({
      propertyId: PROPERTY,
      organizationId: ORGANIZATION,
      clearedAt: NOW.toISOString(),
    });
    const [clearSql] = query.mock.calls[1] as [string, unknown[]];
    expect(clearSql).toContain("billing_status = 'suspended'");
    expect(clearSql).toContain("billing_subscription_ref IS NULL");

    await store.getEntitlement(PROPERTY);
    const [selectSql] = query.mock.calls[2] as [string, unknown[]];
    expect(selectSql).toContain("finance.commission_rules");
    expect(selectSql).toContain("identity.organizations");
  });
});

function legacySnapshot(): StripeSubscriptionSnapshot {
  return {
    subscriptionId: "sub_legacy",
    customerId: "cus_legacy",
    status: "active",
    propertyId: null,
    organizationId: null,
    fixedPlanVerified: false,
    currentPeriodStart: "2026-10-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-31T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    subscriptionItemId: "si_legacy",
    currency: "EUR",
    retainedLegacyPrice: false,
    amountMinor: null,
  };
}

function adoptedSnapshot(): StripeSubscriptionSnapshot {
  return {
    ...legacySnapshot(),
    propertyId: PROPERTY,
    organizationId: ORGANIZATION,
    fixedPlanVerified: true,
    retainedLegacyPrice: true,
    amountMinor: 3_500,
  };
}

function setup(entitlementOverride: Partial<LegacyAdoptionEntitlement> = {}) {
  const entitlement: LegacyAdoptionEntitlement = {
    organizationId: ORGANIZATION,
    propertyId: PROPERTY,
    organizationStatus: "active",
    commissionRuleActive: true,
    planKey: "commission",
    billingStatus: "suspended",
    subscriptionRef: null,
    customerRef: null,
    metadata: { providerReentryRequired: true, legacyPlan: "commission" },
    ...entitlementOverride,
  };
  const inspection: LegacySubscriptionInspection = {
    snapshot: legacySnapshot(),
    hotelId: PROPERTY,
    paymentKind: "fixed_plan",
    flatThirtyDayPrice: true,
    unitAmountMinor: 3_500,
    productId: "prod_legacy",
    adoptionMarker: null,
  };
  // What a re-read returns once the metadata write went through.
  const afterMark: LegacySubscriptionInspection = {
    ...inspection,
    snapshot: adoptedSnapshot(),
    adoptionMarker: "v1",
  };
  let marked = false;
  const store = {
    getEntitlement: vi.fn(async () => entitlement),
    adopt: vi.fn(async () => true),
    clearStaleReference: vi.fn(async () => true),
  } satisfies LegacyAdoptionStore;
  const stripe = {
    inspectLegacySubscription: vi.fn(async () => (marked ? afterMark : inspection)),
    markAdopted: vi.fn(async () => {
      marked = true;
    }),
    findLegacySubscriptionsForHotel: vi.fn(
      async () => [] as Array<{ subscriptionId: string; status: string }>,
    ),
  } satisfies LegacyAdoptionStripe;
  const roomInventory = {
    getRoomInventorySnapshot: vi.fn(
      async (propertyId: string): Promise<RoomInventorySnapshot | null> => ({
        propertyId,
        activeRoomCount: 3,
        capturedAt: NOW.toISOString(),
      }),
    ),
  };
  const refreshPublicBookability = vi.fn(async () => undefined);
  return {
    entitlement,
    inspection,
    afterMark,
    store,
    stripe,
    roomInventory,
    refreshPublicBookability,
    dependencies: { store, stripe, roomInventory, refreshPublicBookability, now: () => NOW },
  };
}
