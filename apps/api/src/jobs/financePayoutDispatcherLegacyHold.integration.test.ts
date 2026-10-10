import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  createPgFinanceAffiliatePayoutDispatcherStore,
  createPgFinancePropertyPayoutDispatcherStore,
} from "./financePayoutDispatcher.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
// VAY-1362 C: the metadata the migration import gives a cohort hotel's open legacy payout, which
// legacy settles (packages/backend-migration productionFinanceRecords settlementReview).
const HELD = {
  legacyPayoutStatus: "scheduled",
  settlementRequiresReview: true,
  settlementReviewReason: "legacy_settles_open_payout",
  activeLegacyTransferWindow: true,
  maxDispatchAttempts: 0,
};

describe.skipIf(!databaseUrl)("payout dispatchers and migration-held legacy payouts", () => {
  it("never selects a cohort hotel's held legacy payout, even with a due dispatch job", async () => {
    if (!databaseUrl || !/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl).pathname.slice(1)))
      throw new Error("Isolated test database required");
    // The dispatcher stores open their own pools, so the fixture commits and is removed after.
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const propertyId = randomUUID();
    const organizationId = randomUUID();
    const accountId = randomUUID();
    const affiliateId = `legacy-hold-${randomUUID()}`;
    const payouts: string[] = [];
    const past = "2026-10-01T00:00:00.000Z";
    const payout = async (
      scope: "property" | "organization",
      status: string,
      metadata: Record<string, unknown>,
    ) => {
      const id = randomUUID();
      payouts.push(id);
      await client.query(
        `INSERT INTO finance.payouts
           (id, owner_scope, property_id, organization_id, property_provider_account_id,
            source_system, source_payout_id, payout_status, amount, net_amount, currency,
            scheduled_at, payout_metadata)
         VALUES ($1, $2, $3, $4, $5, 'pms', $9, $6, 10, 10, 'EUR', $7, $8::jsonb)`,
        [
          id,
          scope,
          scope === "property" ? propertyId : null,
          scope === "organization" ? organizationId : null,
          scope === "property" ? accountId : null,
          status,
          past,
          metadata,
          id,
        ],
      );
      const key =
        scope === "property"
          ? `finance.dispatch-property-payout:property:${propertyId}:payout:${id}:v1`
          : `finance.dispatch-affiliate-payout:affiliate:${affiliateId}:payout:${id}:v1`;
      await client.query(
        `INSERT INTO platform.jobs (job_key, queue_name, job_type, status, run_after, tenant_scope,
           property_id, organization_id, resource_product, resource_type, resource_id)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, 'finance', 'payout', $8)`,
        [
          key,
          scope === "property"
            ? "finance-property-payout-dispatch"
            : "finance-affiliate-payout-dispatch",
          scope === "property"
            ? "finance.dispatch-property-payout"
            : "finance.dispatch-affiliate-payout",
          past,
          scope,
          scope === "property" ? propertyId : null,
          scope === "organization" ? organizationId : null,
          id,
        ],
      );
      return id;
    };
    const property = createPgFinancePropertyPayoutDispatcherStore({
      connectionString: databaseUrl,
    });
    const affiliate = createPgFinanceAffiliatePayoutDispatcherStore({
      connectionString: databaseUrl,
    });
    try {
      await client.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'Payout hold fixture')",
        [propertyId, `payout-hold-${propertyId}`],
      );
      await client.query(
        `INSERT INTO identity.organizations(id, kind, name, slug)
         VALUES ($1, 'affiliate_partner', 'Payout hold affiliate', $2)`,
        [organizationId, `payout-hold-${organizationId}`],
      );
      await client.query(
        `INSERT INTO finance.payment_provider_accounts
           (id, property_id, account_scope, provider, provider_account_id, status, payouts_enabled)
         VALUES ($1, $2, 'property', 'stripe', $3, 'active', TRUE)`,
        [accountId, propertyId, `acct_${accountId.replaceAll("-", "")}`],
      );
      const heldProperty = await payout("property", "processing", HELD);
      const dueProperty = await payout("property", "scheduled", {});
      const heldAffiliate = await payout("organization", "processing", { ...HELD, affiliateId });
      // An unheld in-flight affiliate payout without a lease is re-claimable: the control.
      const dueAffiliate = await payout("organization", "processing", { affiliateId });

      const now = new Date();
      const mine = (rows: Array<{ payoutId: string }>) =>
        rows.map((row) => row.payoutId).filter((id) => payouts.includes(id));
      expect(mine(await property.findDuePropertyPayoutDispatchCandidates(now, 10_000))).toEqual([
        dueProperty,
      ]);
      expect(mine(await affiliate.findDueAffiliatePayoutDispatchCandidates(now, 10_000))).toEqual([
        dueAffiliate,
      ]);
      expect(payouts).toContain(heldProperty);
      expect(payouts).toContain(heldAffiliate);
    } finally {
      await property.close();
      await affiliate.close();
      await client.query(
        "DELETE FROM platform.jobs WHERE resource_product = 'finance' AND resource_id = ANY($1::text[])",
        [payouts],
      );
      await client.query("DELETE FROM finance.payouts WHERE id = ANY($1::uuid[])", [payouts]);
      await client.query("DELETE FROM finance.payment_provider_accounts WHERE id = $1", [
        accountId,
      ]);
      await client.query("DELETE FROM identity.organizations WHERE id = $1", [organizationId]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [propertyId]);
      await client.end();
    }
  });
});
