import type { StripeSubscriptionSnapshot } from "@vayada/domain-finance";
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
      idempotencyKey: `legacy-adoption:${PROPERTY}:sub_legacy:v1`,
    });
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
    });

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.outcome).toBe("already_adopted");
    expect(fixture.stripe.inspectLegacySubscription).not.toHaveBeenCalled();
    expect(fixture.store.adopt).not.toHaveBeenCalled();
  });

  it("finishes a run whose Stripe write succeeded but whose entitlement write did not", async () => {
    const fixture = setup();
    fixture.inspection.adoptionMarker = "v1";
    fixture.inspection.snapshot = adoptedSnapshot();

    const report = await adoptLegacyFixedPlanSubscription(
      { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
      fixture.dependencies,
    );

    expect(report.outcome).toBe("adopted");
    expect(fixture.stripe.markAdopted).not.toHaveBeenCalled();
    expect(fixture.store.adopt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stripe_hotel_id_mismatch", { hotelId: "other-hotel" }],
    ["stripe_payment_kind_mismatch", { paymentKind: "booking" }],
    ["stripe_price_not_flat_30d", { flatThirtyDayPrice: false }],
    ["stripe_status_canceled", { snapshot: { ...legacySnapshot(), status: "canceled" } }],
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

  it("does not write the entitlement when the marked subscription fails verification", async () => {
    const fixture = setup();
    fixture.stripe.markAdopted.mockResolvedValue({
      ...adoptedSnapshot(),
      retainedLegacyPrice: false,
    });

    await expect(
      adoptLegacyFixedPlanSubscription(
        { propertyId: PROPERTY, subscriptionId: "sub_legacy", apply: true },
        fixture.dependencies,
      ),
    ).rejects.toThrow("entitlement unchanged");
    expect(fixture.store.adopt).not.toHaveBeenCalled();
  });

  it("clears a stale legacy reference only when Stripe holds no live subscription", async () => {
    const fixture = setup({
      metadata: { providerReentryRequired: true, legacyBillingReferenceSha256: "abc" },
    });
    fixture.stripe.findLegacySubscriptionsForHotel.mockResolvedValue([
      { subscriptionId: "sub_old", status: "canceled" },
      { subscriptionId: "sub_live", status: "past_due" },
    ]);

    const refused = await clearStaleLegacyBillingReference(
      { propertyId: PROPERTY, apply: true },
      fixture.dependencies,
    );
    expect(refused.outcome).toBe("refused");
    expect(refused.reasons).toEqual(["live_subscription_exists:sub_live"]);
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
    const fixture = setup({ billingStatus: "active" });

    const report = await clearStaleLegacyBillingReference(
      { propertyId: PROPERTY, apply: true },
      fixture.dependencies,
    );

    expect(report.outcome).toBe("refused");
    expect(report.reasons).toEqual(["not_a_stale_legacy_reference", "entitlement_not_suspended"]);
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
    planKey: "commission",
    billingStatus: "suspended",
    subscriptionRef: null,
    customerRef: null,
    metadata: { providerReentryRequired: true },
    ...entitlementOverride,
  };
  const inspection: LegacySubscriptionInspection = {
    snapshot: legacySnapshot(),
    hotelId: PROPERTY,
    paymentKind: "fixed_plan",
    flatThirtyDayPrice: true,
    unitAmountMinor: 3_500,
    adoptionMarker: null,
  };
  const store = {
    getEntitlement: vi.fn(async () => entitlement),
    adopt: vi.fn(async () => true),
    clearStaleReference: vi.fn(async () => true),
  } satisfies LegacyAdoptionStore;
  const stripe = {
    inspectLegacySubscription: vi.fn(async () => inspection),
    markAdopted: vi.fn(async () => adoptedSnapshot()),
    findLegacySubscriptionsForHotel: vi.fn(
      async () => [] as Array<{ subscriptionId: string; status: string }>,
    ),
  } satisfies LegacyAdoptionStripe;
  const roomInventory = {
    getRoomInventorySnapshot: vi.fn(async (propertyId: string) => ({
      propertyId,
      activeRoomCount: 3,
      capturedAt: NOW.toISOString(),
    })),
  };
  const refreshPublicBookability = vi.fn(async () => undefined);
  return {
    entitlement,
    inspection,
    store,
    stripe,
    roomInventory,
    refreshPublicBookability,
    dependencies: { store, stripe, roomInventory, refreshPublicBookability, now: () => NOW },
  };
}
