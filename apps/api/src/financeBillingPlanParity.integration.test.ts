import { randomUUID } from "node:crypto";
import type { FinanceSubscriptionCommandContext } from "@vayada/domain-finance";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createTargetFinanceBillingConfigReadPort } from "./domains/financeBillingConfigReadModel.js";
import { lockFinancePricingAcceptanceTerms } from "./domains/financePricingAcceptanceTerms.js";
import { createPgFinanceSubscriptionStore } from "./domains/financeSubscriptionStore.js";

const url = process.env.TEST_DATABASE_URL;
// The public page lookup has its own tests; here every slug is the property it names.
const scopes = vi.hoisted(() => new Map<string, { propertyId: string; organizationId: string }>());
vi.mock("./domains/publicPricingAuthority.js", () => ({
  lockPublicPricingAuthority: async (_client: unknown, slug: string) => scopes.get(slug) ?? null,
}));

/**
 * Booking readiness asks Finance's billing config whether a hotel has a plan; quote acceptance
 * asks lockFinancePricingAcceptanceTerms. They must agree, or "Ready to publish" would still
 * end in "Quote acceptance unavailable" (VAY-2171).
 */
describe.skipIf(!url)("billing plan: readiness and booking acceptance agree (VAY-2171)", () => {
  it("counts the same plans as usable", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    const store = createPgFinanceSubscriptionStore({ connectionString: "", pool });
    const billing = createTargetFinanceBillingConfigReadPort({ connectionString: "", pool });
    const [organizationId, agencyId] = [randomUUID(), randomUUID()];
    const suffix = randomUUID().replaceAll("-", "");
    const properties: string[] = [];
    const hotel = async () => {
      const propertyId = randomUUID();
      properties.push(propertyId);
      await pool.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::uuid::text,'Parity')",
        [propertyId],
      );
      scopes.set(propertyId, { propertyId, organizationId });
      return propertyId;
    };
    const command = (
      propertyId: string,
      name: string,
      writer = organizationId,
    ): FinanceSubscriptionCommandContext => ({
      commandId: `${name}-${suffix}`,
      idempotencyKey: `${name}-${suffix}`,
      propertyId,
      organizationId: writer,
      audit: {
        actor: { kind: "system", service: "vay2171-parity" },
        requestId: `${name}-${suffix}`,
        reason: name,
        // The terms refuse rows updated after their own clock reading.
        requestedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const details = (propertyId: string) =>
      store.recordBillingDetails(
        {
          ...command(propertyId, `details-${propertyId}`),
          billingDetails: { companyName: "Parity", billingEmail: "p@example.test", taxId: null },
        },
        `cus_${propertyId}`,
        {} as never,
      );
    const usable = async (propertyId: string) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const terms = await lockFinancePricingAcceptanceTerms(client, propertyId);
        await client.query("ROLLBACK");
        return {
          readiness: (await billing.getBillingConfig(propertyId, organizationId)) !== null,
          acceptance: terms !== null,
        };
      } finally {
        client.release();
      }
    };
    const both = (value: boolean) => ({ readiness: value, acceptance: value });
    try {
      for (const [id, slug] of [
        [organizationId, `parity-${suffix}`],
        [agencyId, `parity-agency-${suffix}`],
      ])
        await pool.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Parity',$2)",
          [id, slug],
        );

      // Nothing chosen: no row, billing details only, or a Fixed checkout not finished.
      expect(await usable(await hotel())).toEqual(both(false));
      const detailsOnly = await hotel();
      await details(detailsOnly);
      expect(await usable(detailsOnly)).toEqual(both(false));
      const checkout = await hotel();
      await store.recordCheckout(
        { ...command(checkout, `checkout-${checkout}`), customerEmail: "p@example.test" },
        {
          checkoutSessionId: `cs_${checkout}`,
          checkoutUrl: "https://checkout.stripe.test/session",
          currency: "EUR",
          amountMinor: 3_000,
          activeRoomCount: 1,
        },
      );
      expect(await usable(checkout)).toEqual(both(false));

      // Commission chosen (the setup card), or Fixed activated straight from PMS Billing.
      const commission = await hotel();
      await store.recordCommissionSelection(command(commission, `commission-${commission}`), {
        planStatus: { propertyId: commission } as never,
      });
      expect(await usable(commission)).toEqual(both(true));
      const fixed = await hotel();
      await details(fixed);
      await store.recordFixedActivation(
        command(fixed, `fixed-${fixed}`),
        {
          customerId: `cus_${fixed}`,
          subscriptionId: `sub_${fixed}`,
          status: "active",
          currentPeriodStart: new Date(Date.now() - 60_000).toISOString(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        } as never,
        { planStatus: { amountMinor: 3_000, currency: "EUR", activeRoomCount: 1 } } as never,
        "card",
      );
      expect(await usable(fixed)).toEqual(both(true));

      // Chosen by another organization (say a finance-manager agency): not the hotel's plan.
      const agencyChoice = await hotel();
      await store.recordCommissionSelection(
        command(agencyChoice, `agency-${agencyChoice}`, agencyId),
        { planStatus: { propertyId: agencyChoice } as never },
      );
      expect(await usable(agencyChoice)).toEqual(both(false));

      // A malformed choice (legacy or hand-edited metadata) is no plan for either.
      const malformed = await hotel();
      await store.recordCommissionSelection(command(malformed, `malformed-${malformed}`), {
        planStatus: { propertyId: malformed } as never,
      });
      expect(await usable(malformed)).toEqual(both(true));
      await pool.query(
        `UPDATE finance.billing_entitlements
         SET entitlement_metadata = entitlement_metadata || '{"planSelectedAt":"not a date"}'
         WHERE property_id = $1`,
        [malformed],
      );
      expect(await usable(malformed)).toEqual(both(false));

      // A Commission choice whose 5% rule has ended is no plan for either.
      await pool.query(
        "UPDATE finance.commission_rules SET ends_at=now() - interval '1 second' WHERE source_rule_id=$1",
        [`onboarding-booking:${commission}`],
      );
      expect(await usable(commission)).toEqual(both(false));
    } finally {
      await pool.query("DELETE FROM finance.billing_entitlements WHERE property_id=ANY($1)", [
        properties,
      ]);
      await pool.query("DELETE FROM finance.commission_rules WHERE property_id=ANY($1)", [
        properties,
      ]);
      await pool.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id=ANY($1::uuid[])",
        [[organizationId, agencyId]],
      );
      await pool.end();
    }
  });
});
