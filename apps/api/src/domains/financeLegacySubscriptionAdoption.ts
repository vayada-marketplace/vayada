import type { StripeSubscriptionSnapshot } from "@vayada/domain-finance";
import type { RoomInventoryReadPort } from "@vayada/domain-pms";
import type { QueryResultRow } from "pg";

/**
 * VAY-1362: adopt a live legacy fixed-plan Stripe subscription into the target
 * after the import and before reopen. The subscription, customer, price and
 * 30-day cycle are kept; only metadata is added on Stripe, and the Finance
 * entitlement becomes `fixed`. See engineering/legacy-fixed-plan-billing-handover.md §3.
 */

export const LEGACY_LIVE_STATUSES = new Set(["active", "past_due", "trialing"]);
const PERIOD_END_GUARD_MS = 24 * 60 * 60 * 1_000;

export type LegacyAdoptionEntitlement = {
  organizationId: string;
  propertyId: string;
  organizationStatus: string;
  planKey: string | null;
  billingStatus: string;
  subscriptionRef: string | null;
  customerRef: string | null;
  metadata: Record<string, unknown>;
};

export type LegacySubscriptionInspection = {
  snapshot: StripeSubscriptionSnapshot;
  hotelId: string | null;
  paymentKind: string | null;
  flatThirtyDayPrice: boolean;
  unitAmountMinor: number | null;
  adoptionMarker: string | null;
};

export type LegacyAdoptionStore = {
  getEntitlement(propertyId: string): Promise<LegacyAdoptionEntitlement | null>;
  adopt(input: {
    propertyId: string;
    organizationId: string;
    snapshot: StripeSubscriptionSnapshot;
    activeRoomCount: number;
    adoptedAt: string;
  }): Promise<boolean>;
  clearStaleReference(input: {
    propertyId: string;
    organizationId: string;
    clearedAt: string;
  }): Promise<boolean>;
};

export type LegacyAdoptionStripe = {
  inspectLegacySubscription(subscriptionId: string): Promise<LegacySubscriptionInspection>;
  markAdopted(input: {
    subscriptionId: string;
    propertyId: string;
    organizationId: string;
    idempotencyKey: string;
  }): Promise<StripeSubscriptionSnapshot>;
  findLegacySubscriptionsForHotel(
    hotelId: string,
  ): Promise<Array<{ subscriptionId: string; status: string }>>;
};

export type LegacyAdoptionDependencies = {
  store: LegacyAdoptionStore;
  stripe: LegacyAdoptionStripe;
  roomInventory: RoomInventoryReadPort;
  refreshPublicBookability?: (propertyId: string) => Promise<void>;
  now?: () => Date;
};

export type LegacyAdoptionReport = {
  mode: "adopt" | "clear-stale-reference";
  propertyId: string;
  subscriptionId: string | null;
  apply: boolean;
  outcome: "adopted" | "would_adopt" | "already_adopted" | "cleared" | "would_clear" | "refused";
  reasons: string[];
  entitlementBefore: { planKey: string | null; billingStatus: string } | null;
  stripe: {
    status: string;
    currency: string;
    amountMinor: number | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  activeRoomCount: number | null;
  bookabilityRefreshed: boolean;
};

export async function adoptLegacyFixedPlanSubscription(
  input: { propertyId: string; subscriptionId: string; apply: boolean },
  dependencies: LegacyAdoptionDependencies,
): Promise<LegacyAdoptionReport> {
  const now = dependencies.now?.() ?? new Date();
  const report: LegacyAdoptionReport = {
    mode: "adopt",
    propertyId: input.propertyId,
    subscriptionId: input.subscriptionId,
    apply: input.apply,
    outcome: "refused",
    reasons: [],
    entitlementBefore: null,
    stripe: null,
    activeRoomCount: null,
    bookabilityRefreshed: false,
  };
  const refuse = (reason: string) => {
    report.reasons.push(reason);
  };

  const entitlement = await dependencies.store.getEntitlement(input.propertyId);
  if (!entitlement) {
    refuse("entitlement_not_found");
    return report;
  }
  report.entitlementBefore = {
    planKey: entitlement.planKey,
    billingStatus: entitlement.billingStatus,
  };
  if (entitlement.organizationStatus !== "active") refuse("organization_not_active");
  if (entitlement.planKey === "fixed" && entitlement.subscriptionRef === input.subscriptionId) {
    report.outcome = "already_adopted";
    return report;
  }
  if (entitlement.subscriptionRef && entitlement.subscriptionRef !== input.subscriptionId) {
    refuse("entitlement_bound_to_other_subscription");
  }

  const inspection = await dependencies.stripe.inspectLegacySubscription(input.subscriptionId);
  const { snapshot } = inspection;
  report.stripe = {
    status: snapshot.status,
    currency: snapshot.currency,
    amountMinor: inspection.unitAmountMinor,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
  };
  if (inspection.hotelId !== input.propertyId) refuse("stripe_hotel_id_mismatch");
  if (inspection.paymentKind !== "fixed_plan") refuse("stripe_payment_kind_mismatch");
  if (!LEGACY_LIVE_STATUSES.has(snapshot.status)) refuse(`stripe_status_${snapshot.status}`);
  if (!inspection.flatThirtyDayPrice) refuse("stripe_price_not_flat_30d");
  if (!snapshot.currency) refuse("stripe_currency_invalid");
  if (!snapshot.customerId) refuse("stripe_customer_missing");
  if (
    snapshot.currentPeriodEnd &&
    Date.parse(snapshot.currentPeriodEnd) - now.getTime() < PERIOD_END_GUARD_MS
  ) {
    refuse("within_24h_of_period_end");
  }
  const markedForOther =
    inspection.adoptionMarker !== null &&
    (snapshot.propertyId !== input.propertyId ||
      snapshot.organizationId !== entitlement.organizationId);
  if (markedForOther) refuse("stripe_adopted_for_other_property");

  const inventory = await dependencies.roomInventory.getRoomInventorySnapshot(input.propertyId);
  if (!inventory) refuse("room_inventory_missing");
  else report.activeRoomCount = inventory.activeRoomCount;

  if (report.reasons.length > 0) return report;
  if (!input.apply) {
    report.outcome = "would_adopt";
    return report;
  }

  const adopted =
    inspection.adoptionMarker !== null
      ? snapshot
      : await dependencies.stripe.markAdopted({
          subscriptionId: input.subscriptionId,
          propertyId: input.propertyId,
          organizationId: entitlement.organizationId,
          idempotencyKey: `legacy-adoption:${input.propertyId}:${input.subscriptionId}:v1`,
        });
  if (
    !adopted.fixedPlanVerified ||
    !adopted.retainedLegacyPrice ||
    adopted.propertyId !== input.propertyId ||
    adopted.organizationId !== entitlement.organizationId ||
    typeof adopted.amountMinor !== "number"
  ) {
    throw new Error(
      "Stripe subscription did not verify as an adopted legacy Fixed Plan; entitlement unchanged.",
    );
  }
  const written = await dependencies.store.adopt({
    propertyId: input.propertyId,
    organizationId: entitlement.organizationId,
    snapshot: adopted,
    activeRoomCount: inventory!.activeRoomCount,
    adoptedAt: now.toISOString(),
  });
  if (!written) throw new Error("The billing entitlement changed before adoption was written.");
  report.stripe.amountMinor = adopted.amountMinor;
  report.outcome = "adopted";
  if (dependencies.refreshPublicBookability) {
    await dependencies.refreshPublicBookability(input.propertyId);
    report.bookabilityRefreshed = true;
  }
  return report;
}

export async function clearStaleLegacyBillingReference(
  input: { propertyId: string; apply: boolean },
  dependencies: Pick<
    LegacyAdoptionDependencies,
    "store" | "stripe" | "now" | "refreshPublicBookability"
  >,
): Promise<LegacyAdoptionReport> {
  const now = dependencies.now?.() ?? new Date();
  const report: LegacyAdoptionReport = {
    mode: "clear-stale-reference",
    propertyId: input.propertyId,
    subscriptionId: null,
    apply: input.apply,
    outcome: "refused",
    reasons: [],
    entitlementBefore: null,
    stripe: null,
    activeRoomCount: null,
    bookabilityRefreshed: false,
  };
  const entitlement = await dependencies.store.getEntitlement(input.propertyId);
  if (!entitlement) {
    report.reasons.push("entitlement_not_found");
    return report;
  }
  report.entitlementBefore = {
    planKey: entitlement.planKey,
    billingStatus: entitlement.billingStatus,
  };
  if (entitlement.organizationStatus !== "active") report.reasons.push("organization_not_active");
  if (entitlement.planKey !== "commission") report.reasons.push("plan_not_commission");
  if (entitlement.subscriptionRef) report.reasons.push("subscription_reference_present");
  if (entitlement.metadata["providerReentryRequired"] !== true) {
    report.reasons.push("not_a_stale_legacy_reference");
  }
  if (entitlement.billingStatus !== "suspended") report.reasons.push("entitlement_not_suspended");
  const live = (await dependencies.stripe.findLegacySubscriptionsForHotel(input.propertyId)).filter(
    (subscription) =>
      LEGACY_LIVE_STATUSES.has(subscription.status) || subscription.status === "unpaid",
  );
  for (const subscription of live) {
    report.reasons.push(`live_subscription_exists:${subscription.subscriptionId}`);
  }
  if (report.reasons.length > 0) return report;
  if (!input.apply) {
    report.outcome = "would_clear";
    return report;
  }
  const written = await dependencies.store.clearStaleReference({
    propertyId: input.propertyId,
    organizationId: entitlement.organizationId,
    clearedAt: now.toISOString(),
  });
  if (!written)
    throw new Error("The billing entitlement changed before the reference was cleared.");
  report.outcome = "cleared";
  if (dependencies.refreshPublicBookability) {
    await dependencies.refreshPublicBookability(input.propertyId);
    report.bookabilityRefreshed = true;
  }
  return report;
}

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

export function createPgLegacyAdoptionStore(pool: Queryable): LegacyAdoptionStore {
  return {
    async getEntitlement(propertyId) {
      const result = await pool.query<LegacyAdoptionEntitlement>(
        `SELECT entitlement.organization_id::text AS "organizationId",
                entitlement.property_id::text AS "propertyId",
                organization.status AS "organizationStatus",
                entitlement.plan_key AS "planKey",
                entitlement.billing_status AS "billingStatus",
                entitlement.billing_subscription_ref AS "subscriptionRef",
                entitlement.billing_customer_ref AS "customerRef",
                COALESCE(entitlement.entitlement_metadata, '{}'::jsonb) AS metadata
         FROM finance.billing_entitlements entitlement
         JOIN identity.organizations organization ON organization.id = entitlement.organization_id
         WHERE entitlement.property_id = $1::uuid
           AND entitlement.product = 'booking'
           AND entitlement.entitlement_key = 'direct-booking-finance'
         LIMIT 1`,
        [propertyId],
      );
      return result.rows[0] ?? null;
    },

    async adopt({ propertyId, organizationId, snapshot, activeRoomCount, adoptedAt }) {
      const result = await pool.query(
        `UPDATE finance.billing_entitlements entitlement
         SET plan_key = 'fixed',
             billing_status = CASE WHEN $3 = 'past_due' THEN 'past_due' ELSE 'active' END,
             billing_provider = 'stripe',
             billing_customer_ref = $4,
             billing_subscription_ref = $5,
             checkout_session_ref = NULL,
             provider_subscription_status = $3,
             billing_period_start_at = $6::timestamptz,
             billing_period_end_at = $7::timestamptz,
             billing_period_start = $6::timestamptz::date,
             billing_period_end = $7::timestamptz::date,
             cancel_at_period_end = $8,
             billing_amount_minor = $9,
             billing_currency = $10,
             active_room_count = $11,
             starts_at = COALESCE(entitlement.starts_at, $12::timestamptz),
             entitlement_metadata = entitlement.entitlement_metadata || $13::jsonb,
             last_provider_event_created_at = $12::timestamptz,
             last_provider_event_id = $14,
             updated_at = now()
         WHERE entitlement.property_id = $1::uuid
           AND entitlement.organization_id = $2::uuid
           AND entitlement.product = 'booking'
           AND entitlement.entitlement_key = 'direct-booking-finance'
           AND (entitlement.billing_subscription_ref IS NULL
             OR entitlement.billing_subscription_ref = $5)`,
        [
          propertyId,
          organizationId,
          snapshot.status,
          snapshot.customerId,
          snapshot.subscriptionId,
          snapshot.currentPeriodStart,
          snapshot.currentPeriodEnd,
          snapshot.cancelAtPeriodEnd,
          snapshot.amountMinor,
          snapshot.currency,
          activeRoomCount,
          adoptedAt,
          JSON.stringify({
            subscriptionItemId: snapshot.subscriptionItemId,
            planSelectedAt: adoptedAt,
            planSelectedBy: "legacy-adoption",
            legacyAdoptedAt: adoptedAt,
            providerReentryRequired: false,
          }),
          `legacy-adoption:${snapshot.subscriptionId}`,
        ],
      );
      return result.rowCount === 1;
    },

    async clearStaleReference({ propertyId, organizationId, clearedAt }) {
      const result = await pool.query(
        `UPDATE finance.billing_entitlements entitlement
         SET billing_status = 'active',
             billing_provider = 'none',
             entitlement_metadata = entitlement.entitlement_metadata || $3::jsonb,
             updated_at = now()
         WHERE entitlement.property_id = $1::uuid
           AND entitlement.organization_id = $2::uuid
           AND entitlement.product = 'booking'
           AND entitlement.entitlement_key = 'direct-booking-finance'
           AND entitlement.plan_key = 'commission'
           AND entitlement.billing_status = 'suspended'
           AND entitlement.billing_subscription_ref IS NULL`,
        [
          propertyId,
          organizationId,
          JSON.stringify({
            planSelectedAt: clearedAt,
            planSelectedBy: "legacy-stale-reference-cleared",
            legacyStaleReferenceClearedAt: clearedAt,
            providerReentryRequired: false,
          }),
        ],
      );
      return result.rowCount === 1;
    },
  };
}
