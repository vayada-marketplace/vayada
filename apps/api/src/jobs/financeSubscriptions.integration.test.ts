import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  StripeFinanceSubscriptionProvider,
  StripeSubscriptionSnapshot,
} from "@vayada/domain-finance";
import type { RoomInventoryReadPort } from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgFinanceSubscriptionWebhookStore,
  processFinanceSubscriptionWebhook,
  runFinanceSubscriptionNotificationJobs,
  runFinanceSubscriptionWebhookJobs,
  type FinanceSubscriptionWebhookPayload,
} from "./financeSubscriptions.js";
import { readPropertyPlan } from "../domains/propertyPlanReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationA = "f2000000-0000-4000-8000-000000001120";
const organizationB = "f2000000-0000-4000-8000-000000001121";
const propertyId = "f3000000-0000-4000-8000-000000001120";
const propertyB = "f3000000-0000-4000-8000-000000001121";
const entitlementMigration = await readFile(
  new URL(
    "../../../../packages/backend-migration/migrations/0089_direct_booking_finance_entitlements.sql",
    import.meta.url,
  ),
  "utf8",
);
// 0089 re-creates its sync function; 0483 restores the current one for later suites (VAY-2171).
const entitlementSyncMigration = await readFile(
  new URL(
    "../../../../packages/backend-migration/migrations/0483_finance_entitlement_sync_runtime_columns.sql",
    import.meta.url,
  ),
  "utf8",
);

describe.skipIf(!TEST_DATABASE_URL)("Finance subscription webhook PostgreSQL scoping", () => {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 2,
  });
  const store = createPgFinanceSubscriptionWebhookStore(pool);

  beforeAll(() => assertSafeTestDatabase(TEST_DATABASE_URL!));

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES
         ($1::uuid, 'hotel_group', 'VAY-1120 Integration A', 'vay-1120-integration-a', 'active'),
         ($2::uuid, 'hotel_group', 'VAY-1120 Integration B', 'vay-1120-integration-b', 'active')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay-1120-integration-property', 'VAY-1120 Integration Property'),
              ($2::uuid, 'vay-1296-integration-property-b', 'VAY-1296 Integration Property B')`,
      [propertyId, propertyB],
    );
    await pool.query(
      `INSERT INTO finance.billing_entitlements
         (organization_id, property_id, product, entitlement_key, billing_status,
          plan_key, billing_provider, checkout_session_ref, source_system)
       VALUES
         ($1::uuid, $3::uuid, 'booking', 'direct-booking-finance', 'active',
          'commission', 'stripe', 'cs_vay1120_a', 'finance'),
         ($2::uuid, $3::uuid, 'booking', 'direct-booking-finance', 'active',
          'commission', 'stripe', 'cs_vay1120_b', 'finance'),
         ($1::uuid, $3::uuid, 'pms', 'unrelated-finance-entitlement', 'active',
          'commission', 'stripe', 'cs_vay1120_unrelated', 'finance')`,
      [organizationA, organizationB, propertyId],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  // First in the file: platform.jobs must hold only the first job when it is analyzed (VAY-2426).
  it("claims one notification job per statement, so a batch notifies both", async () => {
    const run = randomUUID();
    const enqueue = (eventId: string) =>
      pool.query(
        `INSERT INTO platform.jobs (job_key, queue_name, job_type, payload)
         VALUES ($1, 'finance.notifications',
           'finance.subscription-payment-failed.notify-internal', $2::jsonb)`,
        [
          `vay2426:${eventId}`,
          JSON.stringify({
            eventId,
            propertyId,
            organizationId: organizationA,
            subscriptionId: "sub_vay2426",
          }),
        ],
      );
    await enqueue(`evt_first_${run}`);
    // Analyzed while it holds one job, PostgreSQL plans a claim that joins its LIMIT 1 candidate
    // as a nested loop, and that claim took both jobs (VAY-2398).
    await pool.query("ANALYZE platform.jobs");
    await enqueue(`evt_second_${run}`);
    const notified: string[] = [];
    await expect(
      runFinanceSubscriptionNotificationJobs(
        TEST_DATABASE_URL!,
        (notification) => void notified.push(notification.eventId),
        { pool, limit: 2 },
      ),
    ).resolves.toEqual({ processed: 2, failed: 0 });
    expect(notified).toEqual([`evt_first_${run}`, `evt_second_${run}`]);
  });

  it("links only the exact organization, product, entitlement key, and Checkout session", async () => {
    const payload = checkoutPayload();
    await expect(store.findEntitlement(payload)).resolves.toMatchObject({
      organizationId: organizationA,
      propertyId,
      checkoutSessionRef: "cs_vay1120_a",
    });

    await expect(
      store.recordCheckoutCompleted({
        payload,
        snapshot: subscriptionSnapshot(),
        activeRoomCount: 3,
      }),
    ).resolves.toMatchObject({
      organizationId: organizationA,
      subscriptionRef: "sub_vay1120_a",
    });

    await expect(
      store.applySubscriptionSnapshot({
        payload: {
          ...payload,
          eventType: "invoice.paid",
          rawEventId: "evt_vay1120_paid_a",
          eventCreated: payload.eventCreated + 1,
          objectId: "in_vay1120_a",
          checkoutSessionId: null,
        },
        snapshot: subscriptionSnapshot(),
        transition: "paid",
        activeRoomCount: 3,
      }),
    ).resolves.toMatchObject({
      organizationId: organizationA,
      planKey: "fixed",
      subscriptionRef: "sub_vay1120_a",
    });

    const rows = await pool.query<{
      organizationId: string;
      product: string;
      entitlementKey: string;
      subscriptionRef: string | null;
      planKey: string | null;
    }>(
      `SELECT organization_id::text AS "organizationId", product,
         entitlement_key AS "entitlementKey", billing_subscription_ref AS "subscriptionRef",
         plan_key AS "planKey"
       FROM finance.billing_entitlements
       WHERE property_id = $1::uuid
       ORDER BY organization_id, product`,
      [propertyId],
    );
    expect(rows.rows).toEqual([
      {
        organizationId: organizationA,
        product: "booking",
        entitlementKey: "direct-booking-finance",
        planKey: "fixed",
        subscriptionRef: "sub_vay1120_a",
      },
      {
        organizationId: organizationA,
        product: "pms",
        entitlementKey: "unrelated-finance-entitlement",
        planKey: "commission",
        subscriptionRef: null,
      },
      {
        organizationId: organizationB,
        product: "booking",
        entitlementKey: "direct-booking-finance",
        planKey: "commission",
        subscriptionRef: null,
      },
    ]);

    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      organizationId: organizationA,
      status: "active",
      resourceProduct: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
    });
  });

  it("projects Finance billing lifecycle state into one linked Identity entitlement", async () => {
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      status: "active",
    });

    await setBillingStatus("past_due");
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      status: "suspended",
    });

    await pool.query(
      `INSERT INTO finance.billing_entitlements
         (organization_id, property_id, product, entitlement_key, billing_status,
          plan_key, billing_provider, source_system, updated_at)
       VALUES ($1::uuid, $2::uuid, 'booking', 'direct-booking-finance',
         'active', 'commission', 'none', 'finance', now())
       ON CONFLICT (organization_id, product, entitlement_key, (COALESCE(property_id::text, '')))
       DO UPDATE SET updated_at = EXCLUDED.updated_at`,
      [organizationA, propertyId],
    );
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      status: "suspended",
    });

    await setBillingStatus("active", "2026-08-12T12:00:00.000Z");
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      status: "expired",
    });

    await setBillingStatus("canceled");
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      status: "expired",
    });

    await setBillingStatus("active");
    const active = await readIdentityEntitlement(organizationA);
    expect(active).toMatchObject({ billingLinked: true, status: "active", expiresAt: null });
    expect(active?.count).toBe(1);

    const unrelated = await pool.query<{ identityEntitlementId: string | null }>(
      `SELECT identity_entitlement_id::text AS "identityEntitlementId"
       FROM finance.billing_entitlements
       WHERE organization_id = $1::uuid AND product = 'pms'`,
      [organizationA],
    );
    expect(unrelated.rows[0]?.identityEntitlementId).toBeNull();
  });

  it("rejects reparenting and expires authorization when its Finance fact is deleted", async () => {
    await expect(
      pool.query(
        `UPDATE finance.billing_entitlements SET property_id = $3::uuid
         WHERE organization_id = $1::uuid AND property_id = $2::uuid
           AND product = 'booking' AND entitlement_key = 'direct-booking-finance'`,
        [organizationA, propertyId, propertyB],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_finance_direct_booking_entitlement_scope_immutable",
    });
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      organizationId: organizationA,
      resourceId: propertyId,
      status: "active",
    });
    await expect(readIdentityEntitlement(organizationA, propertyB)).resolves.toBeNull();

    await pool.query(
      `DELETE FROM finance.billing_entitlements
       WHERE organization_id = $1::uuid AND property_id = $2::uuid
         AND product = 'booking' AND entitlement_key = 'direct-booking-finance'`,
      [organizationB, propertyId],
    );
    await expect(readIdentityEntitlement(organizationB)).resolves.toMatchObject({
      billingLinked: false,
      organizationId: organizationB,
      status: "expired",
    });
  });

  it("backfills an existing unlinked Finance entitlement when the migration runs", async () => {
    await pool.query(
      `DELETE FROM identity.product_entitlements
       WHERE organization_id = $1::uuid
         AND product = 'booking'
         AND entitlement_key = 'direct-booking-finance'`,
      [organizationA],
    );
    await expect(readIdentityEntitlement(organizationA)).resolves.toBeNull();

    await pool.query(entitlementMigration);
    await pool.query(entitlementSyncMigration);

    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      count: 1,
      status: "active",
    });
  });

  it("exposes the active subscription entitlement through property feature limits", async () => {
    await pool.query(
      `DELETE FROM finance.billing_entitlements
       WHERE property_id = $1::uuid
         AND organization_id = $2::uuid
         AND entitlement_key = 'direct-booking-finance'`,
      [propertyId, organizationB],
    );
    await pool.query(
      `UPDATE finance.billing_entitlements
       SET plan_key = 'fixed'
       WHERE property_id = $1::uuid
         AND organization_id = $2::uuid
         AND entitlement_key = 'direct-booking-finance'`,
      [propertyId, organizationA],
    );

    await expect(readPropertyPlan(pool, propertyId)).resolves.toMatchObject({
      propertyId,
      plan: "fixed",
      limits: {
        maxRoomPhotosPerType: 15,
        maxAddons: 9,
        guestContactAccess: "always",
      },
    });
  });

  it("queues one property-scoped alert for a Fixed Fee payment failure; a retry changes nothing", async () => {
    const checkout = checkoutPayload();
    await store.recordCheckoutCompleted({
      payload: checkout,
      snapshot: subscriptionSnapshot(),
      activeRoomCount: 3,
    });
    await store.applySubscriptionSnapshot({
      payload: {
        ...checkout,
        eventType: "invoice.paid",
        rawEventId: "evt_vay2431_paid",
        eventCreated: checkout.eventCreated + 1,
        objectId: "in_vay2431_paid",
        checkoutSessionId: null,
      },
      snapshot: subscriptionSnapshot(),
      transition: "paid",
      activeRoomCount: 3,
    });
    const failed: FinanceSubscriptionWebhookPayload = {
      ...checkout,
      eventType: "invoice.payment_failed",
      rawEventId: "evt_vay2431_failed",
      eventCreated: checkout.eventCreated + 2,
      objectId: "in_vay2431_failed",
      checkoutSessionId: null,
    };
    const dependencies = {
      store,
      stripe: {
        retrieveSubscription: async () => ({ ...subscriptionSnapshot(), status: "past_due" }),
      } as unknown as StripeFinanceSubscriptionProvider,
      roomInventory: {} as RoomInventoryReadPort,
    };

    // The snapshot is saved before the alert; a failure in between retries the whole event.
    const losesAlert = {
      ...store,
      enqueuePaymentFailureNotification: async () => {
        throw new Error("connection lost");
      },
    };
    await expect(
      processFinanceSubscriptionWebhook(failed, { ...dependencies, store: losesAlert }),
    ).rejects.toThrow("connection lost");
    const billing = await readFixedBilling();
    // Before VAY-2431 this insert failed chk_platform_jobs_scope on every attempt.
    await expect(processFinanceSubscriptionWebhook(failed, dependencies)).resolves.toBe("applied");
    await expect(readFixedBilling()).resolves.toEqual(billing);
    expect(billing).toMatchObject({
      planKey: "fixed",
      billingStatus: "past_due",
      providerStatus: "past_due",
      lastProviderEventId: "evt_vay2431_failed",
      identity: { status: "suspended" },
    });

    await expect(processFinanceSubscriptionWebhook(failed, dependencies)).resolves.toBe("applied");
    await expect(readFixedBilling()).resolves.toEqual(billing);

    const alert = {
      eventId: "evt_vay2431_failed",
      propertyId,
      organizationId: organizationA,
      subscriptionId: "sub_vay1120_a",
    };
    const jobs = await pool.query(
      `SELECT tenant_scope AS "tenantScope", organization_id::text AS "organizationId",
         property_id::text AS "propertyId", status, payload
       FROM platform.jobs
       WHERE queue_name = 'finance.notifications' AND property_id = $1::uuid`,
      [propertyId],
    );
    expect(jobs.rows).toEqual([
      {
        tenantScope: "property",
        organizationId: null,
        propertyId,
        status: "pending",
        payload: { ...alert, providerStatus: "past_due" },
      },
    ]);

    const notified: unknown[] = [];
    await expect(
      runFinanceSubscriptionNotificationJobs(
        TEST_DATABASE_URL!,
        (notification) => void notified.push(notification),
        { pool },
      ),
    ).resolves.toEqual({ processed: 1, failed: 0 });
    expect(notified).toEqual([alert]);
  });

  it("completes the hotel website's own subscription events without touching Commission billing", async () => {
    const billing = await readFixedBilling();
    const event = (eventId: string, eventPropertyId: string) =>
      pool.query(
        `INSERT INTO platform.jobs (job_key, queue_name, job_type, payload)
         VALUES ($1, 'finance.subscriptions', 'finance.subscription-webhook', $2::jsonb)
         RETURNING id::text`,
        [
          `vay2422:${eventId}`,
          JSON.stringify({
            provider: "stripe",
            eventType: "invoice.paid",
            rawEventId: eventId,
            eventCreated: 1_786_363_200,
            objectId: `in_${eventId}`,
            subscriptionId: "sub_vay2422_website",
            checkoutSessionId: null,
            propertyId: eventPropertyId,
            organizationId: organizationA,
            customerId: "cus_vay2422",
            vayadaAddon: "hotel_website",
          }),
        ],
      );
    // One hotel with a Commission billing row the ids match, one with no row at all.
    const jobs = [
      (await event("evt_vay2422_commission", propertyId)).rows[0]!.id,
      (await event("evt_vay2422_no_row", propertyB)).rows[0]!.id,
    ];
    let stripeReads = 0;
    const stripe = {
      retrieveSubscription: async () => {
        stripeReads += 1;
        return {
          ...subscriptionSnapshot(),
          subscriptionId: "sub_vay2422_website",
          fixedPlanVerified: false,
        };
      },
    } as unknown as StripeFinanceSubscriptionProvider;

    await runFinanceSubscriptionWebhookJobs(
      TEST_DATABASE_URL!,
      stripe,
      {} as RoomInventoryReadPort,
      {
        limit: 10,
      },
    );

    const after = await pool.query(
      `SELECT status, attempts_count AS attempts, job_metadata->>'lastError' AS "lastError"
       FROM platform.jobs WHERE id = ANY($1::uuid[]) ORDER BY job_key`,
      [jobs],
    );
    // Before VAY-2422 both went back to pending with an error, to retry until dead-lettered.
    expect(after.rows).toEqual([
      { status: "succeeded", attempts: 1, lastError: null },
      { status: "succeeded", attempts: 1, lastError: null },
    ]);
    expect(stripeReads).toBe(0);
    await expect(readFixedBilling()).resolves.toEqual(billing);
  });

  async function readFixedBilling() {
    const result = await pool.query(
      `SELECT plan_key AS "planKey", billing_status AS "billingStatus",
         provider_subscription_status AS "providerStatus",
         billing_subscription_ref AS "subscriptionRef", billing_customer_ref AS "customerRef",
         billing_period_start_at::text AS "periodStart", billing_period_end_at::text AS "periodEnd",
         billing_amount_minor AS "amountMinor", billing_currency AS currency,
         active_room_count AS "activeRoomCount", entitlement_metadata AS metadata,
         starts_at::text AS "startsAt",
         last_provider_event_created_at::text AS "lastProviderEventCreatedAt",
         last_provider_event_id AS "lastProviderEventId"
       FROM finance.billing_entitlements
       WHERE organization_id = $1::uuid AND property_id = $2::uuid
         AND product = 'booking' AND entitlement_key = 'direct-booking-finance'`,
      [organizationA, propertyId],
    );
    return { ...result.rows[0], identity: await readIdentityEntitlement(organizationA) };
  }

  async function cleanup() {
    await pool.query(
      "DELETE FROM platform.jobs WHERE job_key LIKE 'vay2426:%' OR job_key LIKE 'vay2422:%'",
    );
    await pool.query(`DELETE FROM platform.jobs WHERE property_id = ANY($1::uuid[])`, [
      [propertyId, propertyB],
    ]);
    await pool.query(
      `DELETE FROM finance.billing_entitlements
       WHERE property_id = $1::uuid OR organization_id = ANY($2::uuid[])`,
      [propertyId, [organizationA, organizationB]],
    );
    await pool.query(
      `DELETE FROM identity.product_entitlements
       WHERE organization_id = ANY($1::uuid[])
         AND product = 'booking'
         AND entitlement_key = 'direct-booking-finance'`,
      [[organizationA, organizationB]],
    );
    await pool.query(`DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])`, [
      [propertyId, propertyB],
    ]);
    await pool.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
      [organizationA, organizationB],
    ]);
  }

  async function readIdentityEntitlement(organizationId: string, scopedPropertyId = propertyId) {
    const result = await pool.query<{
      billingLinked: boolean;
      count: number;
      expiresAt: string | null;
      organizationId: string;
      resourceId: string;
      resourceProduct: string;
      resourceType: string;
      status: string;
    }>(
      `SELECT EXISTS (
           SELECT 1 FROM finance.billing_entitlements billing
           WHERE billing.identity_entitlement_id = identity.id
         ) AS "billingLinked", count(*) OVER ()::int AS count,
         identity.organization_id::text AS "organizationId", identity.expires_at::text AS "expiresAt",
         identity.resource_id AS "resourceId", identity.resource_product AS "resourceProduct",
         identity.resource_type AS "resourceType", identity.status
       FROM identity.product_entitlements identity
       WHERE identity.organization_id = $1::uuid AND identity.product = 'booking'
         AND identity.entitlement_key = 'direct-booking-finance'
         AND identity.resource_product = 'pms' AND identity.resource_type = 'pms_property'
         AND identity.resource_id = $2`,
      [organizationId, scopedPropertyId],
    );
    return result.rows[0] ?? null;
  }

  async function setBillingStatus(status: string, expiresAt: string | null = null): Promise<void> {
    await pool.query(
      `UPDATE finance.billing_entitlements
       SET billing_status = $3, expires_at = $4::timestamptz
       WHERE organization_id = $1::uuid AND property_id = $2::uuid
         AND product = 'booking' AND entitlement_key = 'direct-booking-finance'`,
      [organizationA, propertyId, status, expiresAt],
    );
  }
});

function checkoutPayload(): FinanceSubscriptionWebhookPayload {
  return {
    provider: "stripe",
    eventType: "checkout.session.completed",
    rawEventId: "evt_vay1120_checkout_a",
    eventCreated: 1_786_363_200,
    objectId: "cs_vay1120_a",
    subscriptionId: "sub_vay1120_a",
    checkoutSessionId: "cs_vay1120_a",
    propertyId,
    organizationId: organizationA,
    customerId: "cus_vay1120_a",
  };
}

function subscriptionSnapshot(): StripeSubscriptionSnapshot {
  return {
    subscriptionId: "sub_vay1120_a",
    customerId: "cus_vay1120_a",
    status: "active",
    propertyId,
    organizationId: organizationA,
    fixedPlanVerified: true,
    currentPeriodStart: "2026-08-11T12:00:00.000Z",
    currentPeriodEnd: "2026-09-10T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    subscriptionItemId: "si_vay1120_a",
    currency: "EUR",
  };
}

function assertSafeTestDatabase(connectionString: string): void {
  const parsed = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("Finance subscription integration tests require a local PostgreSQL database");
  }
  const databaseName = parsed.pathname.slice(1).toLowerCase();
  if (!databaseName.includes("test")) {
    throw new Error("Finance subscription integration database name must identify a test database");
  }
}
