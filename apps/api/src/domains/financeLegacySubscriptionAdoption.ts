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
/** Stripe statuses with nothing left to collect; everything else counts as live. */
const DEAD_STATUSES = new Set(["canceled", "incomplete_expired"]);
const PERIOD_END_GUARD_MS = 24 * 60 * 60 * 1_000;

export type LegacyAdoptionEntitlement = {
  organizationId: string;
  propertyId: string;
  organizationStatus: string;
  /** The property's booking commission rule is active (owner link active, canonical fee). */
  commissionRuleActive: boolean;
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
  /** The Stripe product of the single item's price; pinned in metadata at adoption. */
  productId: string | null;
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
  /** Metadata-only write. The caller re-reads the subscription afterwards. */
  markAdopted(input: {
    subscriptionId: string;
    propertyId: string;
    organizationId: string;
    productId: string;
    idempotencyKey: string;
  }): Promise<void>;
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
  outcome:
    | "adopted"
    | "would_adopt"
    | "already_adopted"
    | "cleared"
    | "would_clear"
    | "already_cleared"
    | "refused";
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

async function refreshBookability(
  report: LegacyAdoptionReport,
  dependencies: Pick<LegacyAdoptionDependencies, "refreshPublicBookability">,
): Promise<void> {
  if (!dependencies.refreshPublicBookability) return;
  try {
    await dependencies.refreshPublicBookability(report.propertyId);
    report.bookabilityRefreshed = true;
  } catch (error) {
    // The entitlement write is committed; report it instead of hiding it behind an exception.
    report.reasons.push(
      `bookability_refresh_failed:${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

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
  // A webhook can bind the subscription between the Stripe write and the
  // entitlement write of an earlier run; only a finished adoption record counts.
  const adoptionRecorded =
    typeof entitlement.metadata["legacyAdoptedAt"] === "string" &&
    entitlement.metadata["providerReentryRequired"] !== true;
  if (
    entitlement.planKey === "fixed" &&
    entitlement.subscriptionRef === input.subscriptionId &&
    adoptionRecorded
  ) {
    report.outcome = "already_adopted";
    if (input.apply) await refreshBookability(report, dependencies);
    return report;
  }
  // Billing must be the only reason the hotel is suspended: the migration also
  // suspends hotels whose owner link is inactive or whose booking fee is
  // noncanonical, and those deactivate the Commission rule (VAY-1362 review #5).
  if (!entitlement.commissionRuleActive) refuse("commission_rule_not_active");
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
  if (!inspection.productId) refuse("stripe_product_missing");
  if (!snapshot.currency) refuse("stripe_currency_invalid");
  if (!snapshot.customerId) refuse("stripe_customer_missing");
  if (!snapshot.currentPeriodEnd) refuse("stripe_period_end_missing");
  else if (Date.parse(snapshot.currentPeriodEnd) - now.getTime() < PERIOD_END_GUARD_MS) {
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

  // Always written: the metadata POST is idempotent and repairs a partial earlier run.
  await dependencies.stripe.markAdopted({
    subscriptionId: input.subscriptionId,
    propertyId: input.propertyId,
    organizationId: entitlement.organizationId,
    productId: inspection.productId!,
    // v2: the request also pins vayada_legacy_product (VAY-1362 review).
    idempotencyKey: `legacy-adoption:${input.propertyId}:${input.subscriptionId}:v2`,
  });
  // Stripe replays the cached reply of an idempotent POST for 24 hours, so a
  // repair run would store a stale status and period. Read the live state.
  const adopted = (await dependencies.stripe.inspectLegacySubscription(input.subscriptionId))
    .snapshot;
  const adoptedAt = (dependencies.now?.() ?? new Date()).toISOString();
  // The subscription may have moved on since the first read (unpaid, canceled,
  // renewed). Writing Fixed then would drop that transition's webhook as stale.
  const adoptedPeriodEnd = adopted.currentPeriodEnd ? Date.parse(adopted.currentPeriodEnd) : NaN;
  if (
    !LEGACY_LIVE_STATUSES.has(adopted.status) ||
    !Number.isFinite(adoptedPeriodEnd) ||
    adoptedPeriodEnd - Date.parse(adoptedAt) < PERIOD_END_GUARD_MS
  ) {
    throw new Error(
      `Stripe subscription is now ${adopted.status} or near its period end; entitlement unchanged. Re-run the dry run.`,
    );
  }
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
    adoptedAt,
  });
  if (!written) throw new Error("The billing entitlement changed before adoption was written.");
  report.stripe = {
    status: adopted.status,
    currency: adopted.currency,
    amountMinor: adopted.amountMinor ?? null,
    currentPeriodEnd: adopted.currentPeriodEnd,
    cancelAtPeriodEnd: adopted.cancelAtPeriodEnd,
  };
  report.outcome = "adopted";
  await refreshBookability(report, dependencies);
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
  if (
    entitlement.planKey === "commission" &&
    entitlement.billingStatus === "active" &&
    !entitlement.subscriptionRef &&
    typeof entitlement.metadata["legacyStaleReferenceClearedAt"] === "string"
  ) {
    report.outcome = "already_cleared";
    if (input.apply) await refreshBookability(report, dependencies);
    return report;
  }
  if (entitlement.organizationStatus !== "active") report.reasons.push("organization_not_active");
  if (entitlement.planKey !== "commission") report.reasons.push("plan_not_commission");
  if (entitlement.subscriptionRef) report.reasons.push("subscription_reference_present");
  if (entitlement.metadata["providerReentryRequired"] !== true) {
    report.reasons.push("not_a_stale_legacy_reference");
  }
  // "Only" a stale reference: the legacy plan was Commission and nothing else
  // suspended the hotel (the migration deactivates the commission rule when the
  // owner link is inactive or the booking fee is noncanonical).
  if (entitlement.metadata["legacyPlan"] !== "commission") {
    report.reasons.push("legacy_plan_not_commission");
  }
  if (!entitlement.commissionRuleActive) report.reasons.push("commission_rule_not_active");
  if (entitlement.billingStatus !== "suspended") report.reasons.push("entitlement_not_suspended");
  // Stripe Search can lag a few seconds to minutes behind writes; a freshly
  // created subscription may be missing. Run this after the legacy freeze.
  const live = (await dependencies.stripe.findLegacySubscriptionsForHotel(input.propertyId)).filter(
    (subscription) => !DEAD_STATUSES.has(subscription.status),
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
  await refreshBookability(report, dependencies);
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
                COALESCE(entitlement.entitlement_metadata, '{}'::jsonb) AS metadata,
                EXISTS (
                  SELECT 1 FROM finance.commission_rules rule
                  WHERE rule.property_id = entitlement.property_id
                    AND rule.product = 'booking'
                    AND rule.rule_scope = 'property'
                    AND rule.status = 'active'
                ) AS "commissionRuleActive"
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
             -- Stripe past_due stays visible in provider_subscription_status; the
             -- hotel keeps working while Stripe retries, as on legacy (section 4).
             billing_status = 'active',
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
             last_provider_event_created_at = GREATEST(
               COALESCE(entitlement.last_provider_event_created_at, '-infinity'::timestamptz),
               $12::timestamptz
             ),
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
