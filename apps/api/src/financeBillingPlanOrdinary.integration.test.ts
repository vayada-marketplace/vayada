import { randomUUID } from "node:crypto";
import type { FinanceSubscriptionCommandContext } from "@vayada/domain-finance";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPgFinanceSubscriptionStore } from "./domains/financeSubscriptionStore.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgFinanceSubscriptionWebhookStore,
  type FinanceSubscriptionWebhookPayload,
} from "./jobs/financeSubscriptions.js";

const url = process.env.TEST_DATABASE_URL;

/** Every billing plan write passes 0089's identity sync trigger, which runs as this login (VAY-2171). */
describe.skipIf(!url)("billing plan writes on the ordinary API login (VAY-2171)", () => {
  it("chooses Commission, starts Fixed Fee checkout, saves billing details and activates Fixed", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const pool = new pg.Pool({ connectionString: fixture.connectionString, max: 2 });
    const store = createPgFinanceSubscriptionStore({ connectionString: "", pool });
    const webhooks = createPgFinanceSubscriptionWebhookStore(pool);
    const suffix = randomUUID().replaceAll("-", "");
    const [organizationId, propertyId] = [randomUUID(), randomUUID()];
    const command = (name: string): FinanceSubscriptionCommandContext => ({
      commandId: `${name}-${suffix}`,
      idempotencyKey: `${name}-${suffix}`,
      propertyId,
      organizationId,
      audit: {
        actor: { kind: "system", service: "vay2171-test" },
        requestId: `${name}-${suffix}`,
        reason: name,
        requestedAt: new Date().toISOString(),
      },
    });
    const identity = async () =>
      (
        await admin.query(
          `SELECT status, metadata->>'planKey' AS "planKey",
             EXISTS (SELECT 1 FROM finance.billing_entitlements billing
               WHERE billing.identity_entitlement_id=identity.id) AS linked
           FROM identity.product_entitlements identity
           WHERE organization_id=$1 AND product='booking' AND entitlement_key='direct-booking-finance'
             AND resource_product='pms' AND resource_type='pms_property' AND resource_id=$2`,
          [organizationId, propertyId],
        )
      ).rows;
    try {
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Plan fixture',$2)",
        [organizationId, `p${suffix}`],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::uuid::text,'Plan fixture')",
        [propertyId],
      );

      // Choose Commission: inserts the billing entitlement, so the trigger inserts the identity row.
      const planStatus = { propertyId } as never;
      await store.recordCommissionSelection(command("select-commission"), { planStatus });
      expect(await identity()).toEqual([{ status: "active", planKey: "commission", linked: true }]);
      const rule = await admin.query(
        "SELECT percentage_rate::int AS rate FROM finance.commission_rules WHERE source_rule_id=$1",
        [`onboarding-booking:${propertyId}`],
      );
      expect(rule.rows).toEqual([{ rate: 5 }]);

      // Fixed Fee checkout and billing details update the row; the trigger upserts identity again.
      const checkout = {
        checkoutSessionId: `cs_${suffix}`,
        checkoutUrl: "https://checkout.stripe.test/session",
        currency: "EUR",
        amountMinor: 3_000,
        activeRoomCount: 1,
      };
      await store.recordCheckout(
        { ...command("fixed-plan-checkout"), customerEmail: "owner@example.test" },
        checkout,
      );
      await store.recordBillingDetails(
        {
          ...command("billing-details"),
          billingDetails: {
            companyName: "Plan fixture",
            billingEmail: "a@example.test",
            taxId: null,
          },
        },
        `cus_${suffix}`,
        {} as never,
      );

      // The Stripe webhook activates Fixed on the same login.
      const payload: FinanceSubscriptionWebhookPayload = {
        provider: "stripe",
        eventType: "checkout.session.completed",
        rawEventId: `evt_${suffix}`,
        eventCreated: Math.floor(Date.now() / 1000),
        objectId: checkout.checkoutSessionId,
        subscriptionId: `sub_${suffix}`,
        checkoutSessionId: checkout.checkoutSessionId,
        propertyId,
        organizationId,
        customerId: `cus_${suffix}`,
      };
      const snapshot = {
        subscriptionId: `sub_${suffix}`,
        customerId: `cus_${suffix}`,
        status: "active",
        propertyId,
        organizationId,
        fixedPlanVerified: true,
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        cancelAtPeriodEnd: false,
        subscriptionItemId: `si_${suffix}`,
        currency: "EUR",
      };
      await expect(
        webhooks.recordCheckoutCompleted({ payload, snapshot, activeRoomCount: 1 }),
      ).resolves.toMatchObject({ planKey: "commission" });
      await expect(
        webhooks.applySubscriptionSnapshot({
          payload: {
            ...payload,
            eventType: "invoice.paid",
            rawEventId: `evt_paid_${suffix}`,
            eventCreated: payload.eventCreated + 1,
            objectId: `in_${suffix}`,
            checkoutSessionId: null,
          },
          snapshot,
          transition: "paid",
          activeRoomCount: 1,
        }),
      ).resolves.toMatchObject({ planKey: "fixed" });
      expect(await identity()).toEqual([{ status: "active", planKey: "fixed", linked: true }]);
    } finally {
      await pool.end();
      await admin.query("DELETE FROM finance.billing_entitlements WHERE property_id=$1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM finance.commission_rules WHERE property_id=$1", [propertyId]);
      await admin.query("DELETE FROM identity.product_entitlements WHERE organization_id=$1", [
        organizationId,
      ]);
      await fixture.drop();
      await admin.end();
    }
  });
});
