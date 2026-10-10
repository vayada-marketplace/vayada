import {
  LEGACY_DEAD_STATUSES,
  LEGACY_LIVE_STATUSES,
  LEGACY_NOT_COLLECTING_STATUSES,
  type LegacyAdoptionStore,
  type LegacySubscriptionInspection,
} from "./financeLegacySubscriptionAdoption.js";

/**
 * VAY-1362 review #2: the reopen gate. Lists every legacy fixed-plan Stripe
 * subscription (Stripe is the only truth: legacy webhooks may never have fired)
 * and classifies it against the target entitlements. Read-only.
 */

export type LegacyInventoryClass =
  | "adopted"
  | "ending"
  | "ended"
  | "adoptable"
  | "needs_revert"
  | "blocked";

/** Classes that keep the reopen gate closed. */
export const LEGACY_INVENTORY_OPEN_CLASSES: ReadonlySet<LegacyInventoryClass> = new Set([
  "adoptable",
  "needs_revert",
  "blocked",
]);

export type LegacyInventoryRow = {
  subscriptionId: string;
  hotelId: string | null;
  cohort: boolean;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Adoption is refused this close to the period end (the 24h guard). */
  withinAdoptionGuard: boolean;
  class: LegacyInventoryClass;
  reason: string | null;
};

export type LegacyInventoryReport = {
  mode: "inventory";
  checkedAt: string;
  reopenAllowed: boolean;
  counts: Record<LegacyInventoryClass, number>;
  subscriptions: LegacyInventoryRow[];
};

export type LegacyInventoryDependencies = {
  stripe: {
    searchLegacyFixedPlanSubscriptions(): Promise<LegacySubscriptionInspection[]>;
    /** Live GET: search results lag writes, so every open row is re-read. */
    inspectLegacySubscription(subscriptionId: string): Promise<LegacySubscriptionInspection>;
  };
  store: Pick<LegacyAdoptionStore, "getEntitlement">;
  now?: () => Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUARD_MS = 24 * 60 * 60 * 1_000;

export async function inventoryLegacyFixedPlanSubscriptions(
  dependencies: LegacyInventoryDependencies,
): Promise<LegacyInventoryReport> {
  const now = dependencies.now?.() ?? new Date();
  const subscriptions: LegacyInventoryRow[] = [];
  for (const found of await dependencies.stripe.searchLegacyFixedPlanSubscriptions()) {
    const inspection = LEGACY_DEAD_STATUSES.has(found.snapshot.status)
      ? found
      : await dependencies.stripe.inspectLegacySubscription(found.snapshot.subscriptionId);
    subscriptions.push(await classify(inspection, dependencies, now));
  }
  subscriptions.sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId));
  const counts = {
    adopted: 0,
    ending: 0,
    ended: 0,
    adoptable: 0,
    needs_revert: 0,
    blocked: 0,
  } satisfies Record<LegacyInventoryClass, number>;
  for (const row of subscriptions) counts[row.class] += 1;
  return {
    mode: "inventory",
    checkedAt: now.toISOString(),
    reopenAllowed: subscriptions.every((row) => !LEGACY_INVENTORY_OPEN_CLASSES.has(row.class)),
    counts,
    subscriptions,
  };
}

async function classify(
  inspection: LegacySubscriptionInspection,
  dependencies: LegacyInventoryDependencies,
  now: Date,
): Promise<LegacyInventoryRow> {
  const { snapshot } = inspection;
  const periodEnd = snapshot.currentPeriodEnd ? Date.parse(snapshot.currentPeriodEnd) : NaN;
  const hotelId = inspection.hotelId && UUID.test(inspection.hotelId) ? inspection.hotelId : null;
  const row = (
    rowClass: LegacyInventoryClass,
    reason: string | null,
    cohort = false,
  ): LegacyInventoryRow => ({
    subscriptionId: snapshot.subscriptionId,
    hotelId: inspection.hotelId,
    cohort,
    status: snapshot.status,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    withinAdoptionGuard: Number.isFinite(periodEnd) && periodEnd - now.getTime() < GUARD_MS,
    class: rowClass,
    reason,
  });

  const entitlement = hotelId ? await dependencies.store.getEntitlement(hotelId) : null;
  const cohort = entitlement !== null;
  if (LEGACY_DEAD_STATUSES.has(snapshot.status)) {
    // Closed for the gate, but a cohort hotel still suspended needs the revert.
    const suspended = cohort && entitlement.billingStatus === "suspended";
    return row("ended", suspended ? "cohort_hotel_needs_revert" : null, cohort);
  }
  if (snapshot.cancelAtPeriodEnd) {
    // Scheduled to end, so the gate holds; a cohort hotel that was never
    // adopted still needs adoption or a revert to leave suspension.
    const notAdopted = cohort && entitlement.subscriptionRef !== snapshot.subscriptionId;
    return row("ending", notAdopted ? "cohort_hotel_not_adopted" : null, cohort);
  }
  if (!hotelId) return row("blocked", "hotel_id_missing_or_invalid");
  if (!entitlement) return row("blocked", "outside_cohort_cancel_at_period_end");

  const bound = entitlement.subscriptionRef === snapshot.subscriptionId;
  if (inspection.adoptionMarker !== null) {
    const recorded =
      bound &&
      entitlement.planKey === "fixed" &&
      typeof entitlement.metadata["legacyAdoptedAt"] === "string" &&
      entitlement.metadata["providerReentryRequired"] !== true;
    if (!recorded) return row("blocked", "adoption_incomplete_rerun_adopt", true);
    // A repriced or edited subscription no longer verifies; its webhooks would dead-letter.
    return snapshot.fixedPlanVerified && snapshot.retainedLegacyPrice === true
      ? row("adopted", null, true)
      : row("blocked", "adopted_subscription_unverifiable", true);
  }
  if (entitlement.subscriptionRef && !bound) {
    return row("blocked", "entitlement_bound_to_other_subscription", true);
  }
  if (LEGACY_NOT_COLLECTING_STATUSES.has(snapshot.status)) {
    return row("needs_revert", "revert_to_commission_and_cancel_in_stripe", true);
  }
  if (snapshot.status === "paused") {
    return row("needs_revert", "cancel_in_stripe_then_revert_to_commission", true);
  }
  if (LEGACY_LIVE_STATUSES.has(snapshot.status)) return row("adoptable", null, true);
  return row("blocked", `unexpected_status_${snapshot.status}`, true);
}
