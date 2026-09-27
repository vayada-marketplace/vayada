import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTargetFinancePropertySettingsRepository } from "./routes/finance.js";

const url = process.env["TEST_DATABASE_URL"];
const org = "15150000-0000-4000-8000-000000000101";
const property = "15150000-0000-4000-8000-000000000102";
const settings = "15150000-0000-4000-8000-000000000103";
const payout = "15150000-0000-4000-8000-000000000104";
const earning = "15150000-0000-4000-8000-000000000105";
const affiliate = "affiliate-pg-1515";

describe.skipIf(!url)("creator payout reconciliation PostgreSQL boundary", () => {
  const client = new pg.Client({ connectionString: url ?? "postgresql://disabled" });

  beforeAll(async () => {
    if (!/localhost|127\.0\.0\.1|postgres-test|postgres_pg/.test(url!))
      throw new Error("Refusing to use a non-test PostgreSQL host");
    await client.connect();
  });
  beforeEach(async () => {
    await client.query("BEGIN");
    await seed(client);
  });
  afterEach(() => client.query("ROLLBACK"));
  afterAll(() => client.end());

  it("reads a creator-workspace payout with only its immutable earning allocation", async () => {
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: url!,
      pool: { query: client.query.bind(client), async end() {} },
    });
    const result = await repository.getAffiliatePayoutDetail?.(affiliate, org, payout, "EUR");
    expect(result).toMatchObject({
      payoutId: payout,
      payoutStatus: "paid",
      amount: "12.00",
      maskedDestination: "Destination ••••",
      maskedProviderReference: null,
      includedEarnings: [
        {
          earningEntryId: earning,
          propertyId: property,
          bookingReference: "••••1515",
          currency: "EUR",
          commissionMinor: "1200",
          adjustmentMinor: "1200",
          appliedMinor: "1200",
        },
      ],
    });
    expect(await repository.getAffiliatePayoutDetail?.(affiliate, org, payout, "USD")).toBeNull();
    expect(
      await repository.getAffiliatePayoutDetail?.(
        affiliate,
        "15150000-0000-4000-8000-000000000199",
        payout,
        "EUR",
      ),
    ).toBeNull();
  });
});

async function seed(client: pg.Client) {
  await client.query(
    `INSERT INTO identity.organizations(id,kind,name,slug,status)
     VALUES($1,'creator_workspace','Creator 1515','creator-1515','active')`,
    [org],
  );
  await client.query(
    `INSERT INTO identity.organization_resource_links
       (organization_id,product,resource_type,resource_id,relationship,status)
     VALUES($1,'affiliate','affiliate',$2,'owner','active')`,
    [org, affiliate],
  );
  await client.query(
    `INSERT INTO hotel_catalog.properties(id,public_id,display_name)
     VALUES($1,'property-1515','Hotel 1515')`,
    [property],
  );
  await client.query(
    `INSERT INTO finance.payout_settings
       (id,organization_id,owner_scope,payout_method,default_currency,status,schedule,
        payout_preferences,sensitive_destination_ref)
     VALUES($1,$2,'organization','manual','EUR','active','{"type":"manual"}',
       jsonb_build_object('affiliateId',$3::text),'vault://destination/secret')`,
    [settings, org, affiliate],
  );
  await client.query(
    `INSERT INTO finance.payouts
       (id,payout_setting_id,owner_scope,organization_id,related_property_id,source_system,
        source_payout_id,payout_status,amount,fee_amount,net_amount,currency,paid_at,payout_metadata)
     VALUES($1,$2,'organization',$3,$4,'finance','portal-1515','paid',12,0,12,'EUR',now(),
       jsonb_build_object('affiliateId',$5::text))`,
    [payout, settings, org, property, affiliate],
  );
  await client.query(
    `INSERT INTO finance.affiliate_earning_allocations
       (earning_entry_id,entry_digest,entry_snapshot,creator_profile_id,affiliate_id,
        organization_id,property_id,booking_id,stay_item_id,agreement_id,policy_version_id,
        source_revision,currency,currency_minor_unit,commission_minor,adjustment_minor,status,
        recorded_at,allocated_at)
     VALUES($1,$2,$3,'creator-1515',$4,$5,$6,'booking-reference-1515','stay-1515',
       'agreement-1515','policy-1515',1,'EUR',2,1200,1200,'allocated',now(),now());
    `,
    [
      earning,
      "a".repeat(64),
      { contractVersion: "finance-affiliate-settlement-entry.v1" },
      affiliate,
      org,
      property,
    ],
  );
  await client.query(
    `INSERT INTO finance.affiliate_earning_allocation_items
       (earning_entry_id,payout_id,applied_minor) VALUES($1,$2,1200)`,
    [earning, payout],
  );
}
