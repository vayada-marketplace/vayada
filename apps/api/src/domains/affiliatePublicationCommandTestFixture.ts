import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");

export { databaseUrl, id };
export const terms = {
  bookingDestinationId: id(30),
  financePolicyVersionId: id(10),
  attributionWindowDays: 14,
};

export function context(): RequestContext {
  return {
    actor: {
      internalUserId: id(1),
      status: "active",
      email: "test@example.test",
      providerIdentity: { provider: "workos", providerUserId: "user-test" },
    },
    selectedOrganization: { organizationId: id(4), kind: "hotel_group", status: "active" },
    membership: {
      membershipId: id(8),
      status: "active",
      roleKey: "owner",
      workosRoleSlugs: [],
      permissions: ["marketplace.profile.manage"],
    },
    linkedResources: [
      {
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: id(3),
        status: "active",
        relationship: "owner",
      },
      {
        product: "marketplace",
        resourceType: "marketplace_offer",
        resourceId: id(2),
        status: "active",
        relationship: "operator",
      },
    ],
    entitlements: [{ product: "marketplace", key: "marketplace-hotel-profile", status: "active" }],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1", source: "api", receivedAt: new Date().toISOString() },
  };
}

export function publicationCommandFixture() {
  const databaseName = `vay1501_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let pool: pg.Pool;
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl!).pathname.slice(1)))
      throw new Error("Requires isolated test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: isolatedUrl.toString(), max: 3 });
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS marketplace,platform,identity,hotel_catalog,finance,booking CASCADE;
      CREATE SCHEMA booking; CREATE SCHEMA finance; CREATE SCHEMA marketplace; CREATE SCHEMA platform; CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog;
      CREATE TABLE identity.users(id UUID PRIMARY KEY);
      CREATE TABLE identity.organizations(id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY, profile_status TEXT DEFAULT 'active');
      CREATE TABLE marketplace.marketplace_offers(id UUID PRIMARY KEY, property_id UUID, organization_id UUID,
        offer_status TEXT DEFAULT 'verified', UNIQUE(id,property_id,organization_id));`);
    const platform = await migration("0010_platform_jobs_events_audit.sql");
    await pool.query(
      platform.slice(
        platform.indexOf("CREATE FUNCTION platform.tenant_scope_key("),
        platform.indexOf("CREATE TABLE platform.domain_events ("),
      ),
    );
    await pool.query(
      platform.slice(
        platform.indexOf("CREATE TABLE platform.idempotency_keys ("),
        platform.indexOf("CREATE TABLE platform.dead_letter_events ("),
      ),
    );
    for (const name of [
      "0173_marketplace_affiliate_offer_terms_drafts.sql",
      "0180_finance_affiliate_percentage_policies.sql",
      "0191_booking_affiliate_destinations.sql",
      "0196_marketplace_published_affiliate_terms.sql",
    ])
      await pool.query(await migration(name));
    await pool.query("INSERT INTO identity.users VALUES ($1);", [id(1)]);
    await pool.query("INSERT INTO identity.organizations VALUES ($1)", [id(4)]);
    await pool.query("INSERT INTO hotel_catalog.properties VALUES ($1),($2)", [id(3), id(6)]);
    await pool.query(`CREATE TABLE identity.organization_resource_links(id UUID PRIMARY KEY, organization_id UUID, resource_id TEXT,
      product TEXT, resource_type TEXT, status TEXT, relationship TEXT);
      INSERT INTO identity.organization_resource_links VALUES ('${id(90)}','${id(4)}','${id(3)}','marketplace','hotel_profile','active','owner'),
      ('${id(91)}','${id(4)}','${id(2)}','marketplace','marketplace_offer','active','operator')`);
    await pool.query(
      `INSERT INTO finance.affiliate_percentage_policy_versions
      (id,property_id,contract_version,model,revenue_basis,eligibility,rate_basis_points,
       created_by_user_id,created_by_organization_id,request_id)
      VALUES ($1,$2,'finance-affiliate-percentage-policy.v1','percentage',
       'accommodation_excluding_taxes_and_extras','verified_completion',1250,$3,$4,'fixture')`,
      [id(10), id(3), id(1), id(4)],
    );
    await pool.query(
      `INSERT INTO finance.affiliate_percentage_policy_approvals
      (policy_version_id,property_id,approved_by_user_id,approved_by_organization_id,request_id)
      VALUES ($1,$2,$3,$4,'fixture')`,
      [id(10), id(3), id(1), id(4)],
    );
    await pool.query(
      `INSERT INTO booking.affiliate_destination_versions
      (id,property_id,display_name,booking_url,created_by_user_id,created_by_organization_id,request_id)
      VALUES ($1,$2,'Synthetic booking page','https://booking.example.invalid/?hotel=42',$3,$4,'fixture')`,
      [id(30), id(3), id(1), id(4)],
    );
    await pool.query(
      "INSERT INTO marketplace.marketplace_offers(id,property_id,organization_id) VALUES($1,$2,$3)",
      [id(2), id(3), id(4)],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${databaseName}`);
    await admin.end();
  });
  return { pool: () => pool };
}
