import type { StripeSubscriptionSnapshot } from "@vayada/domain-finance";
import { describe, expect, it, vi } from "vitest";

import type {
  LegacyAdoptionEntitlement,
  LegacySubscriptionInspection,
} from "./financeLegacySubscriptionAdoption.js";
import { inventoryLegacyFixedPlanSubscriptions } from "./financeLegacySubscriptionInventory.js";

const NOW = new Date("2026-10-20T10:00:00.000Z");
const ORGANIZATION = "f2000000-0000-4000-8000-000000001362";
const hotel = (n: number) => `f3000000-0000-4000-8000-00000000000${n}`;

describe("Legacy fixed-plan subscription inventory", () => {
  it("classifies every legacy subscription and holds the gate while any is open", async () => {
    const entitlements = new Map<string, LegacyAdoptionEntitlement>([
      [hotel(1), entitlement(hotel(1), { planKey: "fixed", subscriptionRef: "sub_adopted" })],
      [hotel(2), entitlement(hotel(2))],
      [hotel(3), entitlement(hotel(3))],
      [hotel(4), entitlement(hotel(4), { planKey: "fixed", subscriptionRef: "sub_half" })],
      [hotel(5), entitlement(hotel(5))],
      [hotel(6), entitlement(hotel(6))],
    ]);
    entitlements.get(hotel(4))!.metadata = { providerReentryRequired: true };
    const getEntitlement = vi.fn(async (id: string) => entitlements.get(id) ?? null);
    const search = vi.fn(async () => [
      inspection("sub_adopted", hotel(1), { adoptionMarker: "v1", snapshot: verified }),
      inspection("sub_live", hotel(2), {
        snapshot: { status: "past_due", currentPeriodEnd: "2026-10-21T09:00:00.000Z" },
      }),
      inspection("sub_unpaid", hotel(3), { snapshot: { status: "unpaid" } }),
      inspection("sub_half", hotel(4), { adoptionMarker: "v1", snapshot: verified }),
      inspection("sub_outside", hotel(9)),
      inspection("sub_outside_ending", hotel(8), { snapshot: { cancelAtPeriodEnd: true } }),
      inspection("sub_cohort_ending", hotel(5), { snapshot: { cancelAtPeriodEnd: true } }),
      inspection("sub_old", hotel(6), { snapshot: { status: "canceled" } }),
      inspection("sub_paused", hotel(6), { snapshot: { status: "paused" } }),
      inspection("sub_no_hotel", null),
    ]);

    const report = await inventoryLegacyFixedPlanSubscriptions({
      stripe: {
        searchLegacyFixedPlanSubscriptions: search,
        inspectLegacySubscription: async (id) =>
          (await search()).find((found) => found.snapshot.subscriptionId === id)!,
      },
      store: { getEntitlement },
      now: () => NOW,
    });

    const byId = Object.fromEntries(
      report.subscriptions.map((row) => [row.subscriptionId, [row.class, row.reason]]),
    );
    expect(byId).toEqual({
      sub_adopted: ["adopted", null],
      sub_live: ["adoptable", null],
      sub_unpaid: ["needs_revert", "revert_to_commission_and_cancel_in_stripe"],
      sub_half: ["blocked", "adoption_incomplete_rerun_adopt"],
      sub_outside: ["blocked", "outside_cohort_cancel_at_period_end"],
      sub_outside_ending: ["ending", null],
      sub_cohort_ending: ["ending", "cohort_hotel_not_adopted"],
      sub_old: ["ended", "cohort_hotel_needs_revert"],
      sub_paused: ["needs_revert", "cancel_in_stripe_then_revert_to_commission"],
      sub_no_hotel: ["blocked", "hotel_id_missing_or_invalid"],
    });
    expect(report.subscriptions.find((row) => row.subscriptionId === "sub_live")).toMatchObject({
      status: "past_due",
      cohort: true,
      withinAdoptionGuard: true,
    });
    expect(report.counts).toEqual({
      adopted: 1,
      ending: 2,
      ended: 1,
      adoptable: 1,
      needs_revert: 2,
      blocked: 3,
    });
    expect(report.reopenAllowed).toBe(false);
    // Only identifiers and Stripe state: no customer, name or email field.
    expect(Object.keys(report.subscriptions[0]!).sort()).toEqual([
      "cancelAtPeriodEnd",
      "class",
      "cohort",
      "currentPeriodEnd",
      "hotelId",
      "reason",
      "status",
      "subscriptionId",
      "withinAdoptionGuard",
    ]);
  });

  it("re-reads open rows live and blocks an adopted subscription that no longer verifies", async () => {
    const adopted = entitlement(hotel(1), { planKey: "fixed", subscriptionRef: "sub_adopted" });
    const inspect = vi.fn(async () =>
      inspection("sub_adopted", hotel(1), { adoptionMarker: "v1", snapshot: { status: "active" } }),
    );
    const report = await inventoryLegacyFixedPlanSubscriptions({
      stripe: {
        // Search still shows the stale cancel_at_period_end the hotel has since undone.
        searchLegacyFixedPlanSubscriptions: async () => [
          inspection("sub_adopted", hotel(1), {
            adoptionMarker: "v1",
            snapshot: { ...verified, cancelAtPeriodEnd: true },
          }),
        ],
        inspectLegacySubscription: inspect,
      },
      store: { getEntitlement: async () => adopted },
      now: () => NOW,
    });

    expect(inspect).toHaveBeenCalledWith("sub_adopted");
    expect(report.subscriptions[0]).toMatchObject({
      class: "blocked",
      reason: "adopted_subscription_unverifiable",
      cancelAtPeriodEnd: false,
    });
    expect(report.reopenAllowed).toBe(false);
  });

  it("allows reopen once every subscription is adopted, ending or ended", async () => {
    const adopted = entitlement(hotel(1), { planKey: "fixed", subscriptionRef: "sub_adopted" });
    const found = [
      inspection("sub_adopted", hotel(1), { adoptionMarker: "v1", snapshot: verified }),
      inspection("sub_outside", hotel(9), { snapshot: { cancelAtPeriodEnd: true } }),
      inspection("sub_old", hotel(9), { snapshot: { status: "incomplete_expired" } }),
    ];
    const report = await inventoryLegacyFixedPlanSubscriptions({
      stripe: {
        searchLegacyFixedPlanSubscriptions: async () => found,
        inspectLegacySubscription: async (id) =>
          found.find((item) => item.snapshot.subscriptionId === id)!,
      },
      store: { getEntitlement: async (id) => (id === hotel(1) ? adopted : null) },
      now: () => NOW,
    });

    expect(report.reopenAllowed).toBe(true);
  });
});

const verified = { fixedPlanVerified: true, retainedLegacyPrice: true, amountMinor: 3_500 };

function entitlement(
  propertyId: string,
  override: Partial<LegacyAdoptionEntitlement> = {},
): LegacyAdoptionEntitlement {
  const fixed = override.planKey === "fixed";
  return {
    organizationId: ORGANIZATION,
    propertyId,
    organizationStatus: "active",
    commissionRuleActive: true,
    planKey: "commission",
    billingStatus: fixed ? "active" : "suspended",
    subscriptionRef: null,
    customerRef: null,
    metadata: fixed
      ? { legacyAdoptedAt: NOW.toISOString(), providerReentryRequired: false }
      : { providerReentryRequired: true, legacyPlan: "fixed" },
    ...override,
  };
}

function inspection(
  subscriptionId: string,
  hotelId: string | null,
  override: {
    adoptionMarker?: string;
    snapshot?: Partial<StripeSubscriptionSnapshot>;
  } = {},
): LegacySubscriptionInspection {
  return {
    snapshot: {
      subscriptionId,
      customerId: "cus_legacy",
      status: "active",
      propertyId: null,
      organizationId: null,
      fixedPlanVerified: false,
      currentPeriodStart: "2026-10-10T00:00:00.000Z",
      currentPeriodEnd: "2026-11-09T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      subscriptionItemId: "si_legacy",
      currency: "EUR",
      ...override.snapshot,
    },
    hotelId,
    paymentKind: "fixed_plan",
    flatThirtyDayPrice: true,
    unitAmountMinor: 3_500,
    productId: "prod_legacy",
    adoptionMarker: override.adoptionMarker ?? null,
  };
}
