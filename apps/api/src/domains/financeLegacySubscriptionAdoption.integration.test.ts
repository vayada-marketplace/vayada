import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgFinanceSubscriptionWebhookStore,
  type FinanceSubscriptionWebhookPayload,
} from "../jobs/financeSubscriptions.js";
import {
  adoptLegacyFixedPlanSubscription,
  clearStaleLegacyBillingReference,
  createPgLegacyAdoptionStore,
  type LegacyAdoptionStripe,
} from "./financeLegacySubscriptionAdoption.js";
import { createTargetFinanceBillingConfigReadPort } from "./financeBillingConfigReadModel.js";
import { inspectLegacySubscription } from "./stripeLegacySubscriptionAdoption.js";

/**
 * VAY-1362 review #7: the adopt, clear-stale, revert and dunning SQL against a
 * migrated target database, including the 0089 trigger that projects
 * finance.billing_entitlements into identity.product_entitlements.
 */

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ORGANIZATION = "f2000000-0000-4000-8000-000000013620";
const PROPERTY = "f3000000-0000-4000-8000-000000013620";
const OTHER_PROPERTY = "f3000000-0000-4000-8000-000000013621";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const PERIOD_START = 1_792_000_000; // 2026-10-15
const PERIOD_END = PERIOD_START + 30 * 24 * 60 * 60;

describe.skipIf(!TEST_DATABASE_URL)("Legacy fixed-plan adoption PostgreSQL", () => {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 2,
  });
  const store = createPgLegacyAdoptionStore(pool);
  const webhookStore = createPgFinanceSubscriptionWebhookStore(pool);
  const billingConfig = createTargetFinanceBillingConfigReadPort({ connectionString: "", pool });

  beforeAll(() => assertSafeTestDatabase(TEST_DATABASE_URL!));

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1362 Billing', 'vay-1362-billing-it', 'active')`,
      [ORGANIZATION],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay-1362-billing-it-a', 'VAY-1362 Billing A'),
              ($2::uuid, 'vay-1362-billing-it-b', 'VAY-1362 Billing B')`,
      [PROPERTY, OTHER_PROPERTY],
    );
    for (const propertyId of [PROPERTY, OTHER_PROPERTY]) {
      await pool.query(
        `INSERT INTO finance.commission_rules
           (property_id, organization_id, rule_scope, product, commission_type,
            percentage_rate, status, source_rule_id)
         VALUES ($1::uuid, $2::uuid, 'property', 'booking', 'percentage', 5, 'active',
           'onboarding-booking:' || $1::text)`,
        [propertyId, ORGANIZATION],
      );
      // As the migration lands a legacy hotel with a billing reference.
      await pool.query(
        `INSERT INTO finance.billing_entitlements
           (organization_id, property_id, product, entitlement_key, billing_status,
            plan_key, billing_provider, source_system, starts_at, entitlement_metadata)
         VALUES ($1::uuid, $2::uuid, 'booking', 'direct-booking-finance', 'suspended',
           'commission', 'manual', 'finance', '2026-01-01T00:00:00Z',
           '{"legacyPlan":"fixed","providerReentryRequired":true}'::jsonb)`,
        [ORGANIZATION, propertyId],
      );
    }
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("adopts in place: fixed, active, retained amount, and an active product entitlement", async () => {
    await expect(readIdentityStatus(PROPERTY)).resolves.toBe("suspended");

    const report = await adopt(PROPERTY, legacySubscription(PROPERTY, "sub_vay1362_it_a"));

    expect(report).toMatchObject({ outcome: "adopted", reasons: [] });
    await expect(readEntitlement(PROPERTY)).resolves.toMatchObject({
      planKey: "fixed",
      billingStatus: "active",
      billingProvider: "stripe",
      subscriptionRef: "sub_vay1362_it_a",
      customerRef: "cus_vay1362_it",
      providerStatus: "active",
      amountMinor: 3_500,
      currency: "EUR",
      activeRoomCount: 3,
      planSelectedBy: "legacy-adoption",
      providerReentryRequired: false,
    });
    await expect(readIdentityStatus(PROPERTY)).resolves.toBe("active");

    // Idempotent re-run, and the unique subscription reference holds across hotels.
    await expect(
      adopt(PROPERTY, legacySubscription(PROPERTY, "sub_vay1362_it_a")),
    ).resolves.toMatchObject({ outcome: "already_adopted" });
    await expect(
      store.adopt({
        propertyId: OTHER_PROPERTY,
        organizationId: ORGANIZATION,
        snapshot: inspectLegacySubscription(
          marked(legacySubscription(PROPERTY, "sub_vay1362_it_a"), PROPERTY),
        ).snapshot,
        activeRoomCount: 1,
        adoptedAt: NOW.toISOString(),
      }),
    ).rejects.toThrow();
  });

  it("keeps an adopted hotel working through dunning and reverts it to Commission when unpaid", async () => {
    await adopt(PROPERTY, legacySubscription(PROPERTY, "sub_vay1362_it_a", "past_due"));
    await expect(readEntitlement(PROPERTY)).resolves.toMatchObject({
      billingStatus: "active",
      providerStatus: "past_due",
    });
    await expect(readIdentityStatus(PROPERTY)).resolves.toBe("active");

    const retry = marked(legacySubscription(PROPERTY, "sub_vay1362_it_a", "past_due"), PROPERTY);
    await webhookStore.applySubscriptionSnapshot({
      payload: payload("invoice.payment_failed", "evt_vay1362_it_failed", 60),
      snapshot: inspectLegacySubscription(retry).snapshot,
      transition: "payment_failed",
      activeRoomCount: 3,
    });
    await expect(readEntitlement(PROPERTY)).resolves.toMatchObject({
      planKey: "fixed",
      billingStatus: "active",
      providerStatus: "past_due",
    });
    await expect(readIdentityStatus(PROPERTY)).resolves.toBe("active");
    // Booking terms still resolve to Fixed during retries, as on legacy.
    await expect(billingConfig.getBillingConfig(PROPERTY)).resolves.toMatchObject({
      activePlan: "fixed",
    });

    const unpaid = marked(legacySubscription(PROPERTY, "sub_vay1362_it_a", "unpaid"), PROPERTY);
    await webhookStore.applySubscriptionSnapshot({
      payload: payload("customer.subscription.updated", "evt_vay1362_it_unpaid", 120),
      snapshot: inspectLegacySubscription(unpaid).snapshot,
      transition: "sync",
      activeRoomCount: 3,
    });
    await expect(readEntitlement(PROPERTY)).resolves.toMatchObject({
      planKey: "commission",
      billingStatus: "active",
      providerStatus: "unpaid",
      planSelectedBy: "fixed-subscription-unpaid",
    });
    await expect(readIdentityStatus(PROPERTY)).resolves.toBe("active");
  });

  it("refuses adoption when the hotel is also suspended for a non-billing reason", async () => {
    await pool.query(
      `UPDATE finance.commission_rules SET status = 'inactive' WHERE property_id = $1::uuid`,
      [PROPERTY],
    );

    const report = await adopt(PROPERTY, legacySubscription(PROPERTY, "sub_vay1362_it_a"));

    expect(report.reasons).toEqual(["commission_rule_not_active"]);
    await expect(readEntitlement(PROPERTY)).resolves.toMatchObject({
      planKey: "commission",
      billingStatus: "suspended",
    });
  });

  it("clears a stale Commission reference and reverts an ended Fixed one only with the flag", async () => {
    await pool.query(
      `UPDATE finance.billing_entitlements
       SET entitlement_metadata = entitlement_metadata || '{"legacyPlan":"commission"}'::jsonb
       WHERE property_id = $1::uuid`,
      [OTHER_PROPERTY],
    );
    const stripe = stripePort([]);

    await expect(
      clearStaleLegacyBillingReference(
        { propertyId: OTHER_PROPERTY, apply: true },
        { store, stripe, now: () => NOW },
      ),
    ).resolves.toMatchObject({ outcome: "cleared" });
    await expect(readEntitlement(OTHER_PROPERTY)).resolves.toMatchObject({
      planKey: "commission",
      billingStatus: "active",
      billingProvider: "none",
      planSelectedBy: "legacy-stale-reference-cleared",
      providerReentryRequired: false,
    });
    await expect(readIdentityStatus(OTHER_PROPERTY)).resolves.toBe("active");

    const ended = stripePort([{ subscriptionId: "sub_vay1362_it_a", status: "unpaid" }]);
    await expect(
      clearStaleLegacyBillingReference(
        { propertyId: PROPERTY, apply: true },
        { store, stripe: ended, now: () => NOW },
      ),
    ).resolves.toMatchObject({
      outcome: "refused",
      reasons: ["legacy_plan_fixed_needs_revert_flag"],
    });
    await expect(
      clearStaleLegacyBillingReference(
        { propertyId: PROPERTY, apply: true, revertLegacyFixed: true },
        { store, stripe: ended, now: () => NOW },
      ),
    ).resolves.toMatchObject({
      outcome: "cleared",
      warnings: ["cancel_in_stripe:sub_vay1362_it_a:unpaid"],
    });
    await expect(readEntitlement(PROPERTY)).resolves.toMatchObject({
      planKey: "commission",
      billingStatus: "active",
      planSelectedBy: "legacy-fixed-reverted-to-commission",
    });
    await expect(readIdentityStatus(PROPERTY)).resolves.toBe("active");
  });

  it("resets a legacy Fixed hotel without any billing reference to active, bookable Commission", async () => {
    // As the import lands a legacy Fixed hotel whose payment settings hold no
    // billing reference at all.
    await pool.query(
      `UPDATE finance.billing_entitlements
       SET entitlement_metadata = entitlement_metadata
         || '{"providerReentryRequired":false,"legacyBillingReferenceSha256":null}'::jsonb
       WHERE property_id = $1::uuid`,
      [PROPERTY],
    );
    const none = stripePort([]);

    await expect(
      clearStaleLegacyBillingReference(
        { propertyId: PROPERTY, apply: true, revertLegacyFixed: true },
        { store, stripe: none, now: () => NOW },
      ),
    ).resolves.toMatchObject({ outcome: "refused", reasons: ["not_a_stale_legacy_reference"] });
    await expect(
      clearStaleLegacyBillingReference(
        { propertyId: PROPERTY, apply: true, legacyFixedWithoutSubscription: true },
        {
          store,
          stripe: stripePort([{ subscriptionId: "sub_vay1362_it_a", status: "active" }]),
          now: () => NOW,
        },
      ),
    ).resolves.toMatchObject({ outcome: "refused" });
    await expect(readEntitlement(PROPERTY)).resolves.toMatchObject({ billingStatus: "suspended" });

    await expect(
      clearStaleLegacyBillingReference(
        { propertyId: PROPERTY, apply: true, legacyFixedWithoutSubscription: true },
        { store, stripe: none, now: () => NOW },
      ),
    ).resolves.toMatchObject({ outcome: "cleared" });
    await expect(readEntitlement(PROPERTY)).resolves.toMatchObject({
      planKey: "commission",
      billingStatus: "active",
      billingProvider: "none",
      planSelectedBy: "legacy-fixed-without-subscription-to-commission",
      providerReentryRequired: false,
    });
    await expect(readIdentityStatus(PROPERTY)).resolves.toBe("active");
    // The two entitlement conditions public bookability reads (billing_config_ready).
    const bookable = await pool.query<{ ready: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM finance.billing_entitlements entitlement
         WHERE entitlement.property_id = $1::uuid AND entitlement.product = 'booking'
           AND entitlement.entitlement_key = 'direct-booking-finance'
           AND entitlement.billing_status IN ('trialing', 'active')
           AND entitlement.plan_key = 'commission'
           AND NULLIF(entitlement.entitlement_metadata ->> 'planSelectedAt', '') IS NOT NULL
       ) AS ready`,
      [PROPERTY],
    );
    expect(bookable.rows[0]?.ready).toBe(true);

    await expect(
      clearStaleLegacyBillingReference(
        { propertyId: PROPERTY, apply: true, legacyFixedWithoutSubscription: true },
        { store, stripe: none, now: () => NOW },
      ),
    ).resolves.toMatchObject({ outcome: "already_cleared" });
  });

  async function adopt(propertyId: string, raw: Record<string, unknown>) {
    let current = raw;
    const stripe: LegacyAdoptionStripe = {
      inspectLegacySubscription: async () => inspectLegacySubscription(current),
      markAdopted: async () => {
        current = marked(current, propertyId);
      },
      findLegacySubscriptionsForHotel: async () => [],
    };
    return adoptLegacyFixedPlanSubscription(
      { propertyId, subscriptionId: String(raw["id"]), apply: true },
      {
        store,
        stripe,
        roomInventory: {
          getRoomInventorySnapshot: async (id: string) => ({
            propertyId: id,
            activeRoomCount: 3,
            capturedAt: NOW.toISOString(),
          }),
        },
        now: () => NOW,
      },
    );
  }

  async function readEntitlement(propertyId: string) {
    const result = await pool.query(
      `SELECT plan_key AS "planKey", billing_status AS "billingStatus",
         billing_provider AS "billingProvider", billing_subscription_ref AS "subscriptionRef",
         billing_customer_ref AS "customerRef", provider_subscription_status AS "providerStatus",
         billing_amount_minor::int AS "amountMinor", billing_currency AS currency,
         active_room_count AS "activeRoomCount",
         entitlement_metadata ->> 'planSelectedBy' AS "planSelectedBy",
         (entitlement_metadata -> 'providerReentryRequired')::boolean AS "providerReentryRequired"
       FROM finance.billing_entitlements
       WHERE property_id = $1::uuid AND product = 'booking'
         AND entitlement_key = 'direct-booking-finance'`,
      [propertyId],
    );
    return result.rows[0] ?? null;
  }

  async function readIdentityStatus(propertyId: string): Promise<string | null> {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM identity.product_entitlements
       WHERE organization_id = $1::uuid AND product = 'booking'
         AND entitlement_key = 'direct-booking-finance'
         AND resource_type = 'pms_property' AND resource_id = $2`,
      [ORGANIZATION, propertyId],
    );
    return result.rows[0]?.status ?? null;
  }

  async function cleanup() {
    await pool.query(`DELETE FROM finance.billing_entitlements WHERE organization_id = $1::uuid`, [
      ORGANIZATION,
    ]);
    await pool.query(
      `DELETE FROM identity.product_entitlements
       WHERE organization_id = $1::uuid AND entitlement_key = 'direct-booking-finance'`,
      [ORGANIZATION],
    );
    await pool.query(`DELETE FROM finance.commission_rules WHERE organization_id = $1::uuid`, [
      ORGANIZATION,
    ]);
    await pool.query(`DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])`, [
      [PROPERTY, OTHER_PROPERTY],
    ]);
    await pool.query(`DELETE FROM identity.organizations WHERE id = $1::uuid`, [ORGANIZATION]);
  }
});

function stripePort(
  found: Array<{ subscriptionId: string; status: string }>,
): LegacyAdoptionStripe {
  return {
    inspectLegacySubscription: async () => {
      throw new Error("not used");
    },
    markAdopted: async () => {
      throw new Error("not used");
    },
    findLegacySubscriptionsForHotel: async () => found,
  };
}

/** A legacy subscription as Stripe returns it (inline flat price, quantity 1). */
function legacySubscription(
  hotelId: string,
  id: string,
  status = "active",
): Record<string, unknown> {
  return {
    id,
    customer: "cus_vay1362_it",
    status,
    cancel_at_period_end: false,
    metadata: { hotel_id: hotelId, vayada_payment_kind: "fixed_plan" },
    items: {
      data: [
        {
          id: "si_vay1362_it",
          quantity: 1,
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
          price: {
            id: "price_vay1362_it",
            currency: "eur",
            billing_scheme: "per_unit",
            unit_amount: 3_500,
            product: "prod_vay1362_it",
            recurring: { interval: "day", interval_count: 30, usage_type: "licensed" },
          },
        },
      ],
    },
  };
}

/** The same subscription after the adoption command's metadata write. */
function marked(raw: Record<string, unknown>, propertyId: string): Record<string, unknown> {
  return {
    ...raw,
    metadata: {
      ...(raw["metadata"] as Record<string, string>),
      vayada_property_id: propertyId,
      vayada_organization_id: ORGANIZATION,
      vayada_plan: "fixed",
      vayada_legacy_adoption: "v1",
      vayada_legacy_product: "prod_vay1362_it",
    },
  };
}

function payload(
  eventType: string,
  rawEventId: string,
  secondsAfterAdoption: number,
): FinanceSubscriptionWebhookPayload {
  return {
    provider: "stripe",
    eventType,
    rawEventId,
    eventCreated: Math.floor(NOW.getTime() / 1_000) + secondsAfterAdoption,
    objectId: rawEventId,
    subscriptionId: "sub_vay1362_it_a",
    checkoutSessionId: null,
    propertyId: PROPERTY,
    organizationId: ORGANIZATION,
    customerId: "cus_vay1362_it",
  };
}

function assertSafeTestDatabase(connectionString: string): void {
  const parsed = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("Legacy adoption integration tests require a local PostgreSQL database");
  }
  if (!parsed.pathname.slice(1).toLowerCase().includes("test")) {
    throw new Error("Legacy adoption integration database name must identify a test database");
  }
}
