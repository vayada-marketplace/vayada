import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";

export const databaseUrl = process.env["TEST_DATABASE_URL"];
export const id = (n: number) => `15100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = await readFile(
  new URL("0195_finance_affiliate_earning_journal.sql", migrations),
  "utf8",
);
const platform = await readFile(new URL("0010_platform_jobs_events_audit.sql", migrations), "utf8");

// Synthetic hotel management identity only, not a real authenticated session.
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
    ],
    entitlements: [{ product: "marketplace", key: "marketplace-hotel-profile", status: "active" }],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1", source: "api", receivedAt: new Date().toISOString() },
  };
}

// Minimal parent records plus the real journal SQL/immutability function. No publication,
// booking, collection or accepted-agreement proof is created by this fixture.
export function earningJournalFixture() {
  const name = `vay1510_journal_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let pool: pg.Pool;
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl!).pathname.slice(1)))
      throw new Error("Requires isolated test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS finance,platform,identity,hotel_catalog CASCADE;
      CREATE SCHEMA finance; CREATE SCHEMA platform; CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog;
      CREATE TABLE identity.users(id UUID PRIMARY KEY);
      CREATE TABLE identity.organizations(id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY, profile_status TEXT DEFAULT 'active');
      CREATE TABLE identity.organization_resource_links(id UUID PRIMARY KEY, organization_id UUID,
        product TEXT, resource_type TEXT, resource_id TEXT, status TEXT, relationship TEXT);`);
    await pool.query(
      platform.slice(
        platform.indexOf("CREATE FUNCTION platform.prevent_append_only_mutation()"),
        platform.indexOf("CREATE TABLE platform.domain_events ("),
      ),
    );
    await pool.query(migration);
    await pool.query("INSERT INTO identity.users VALUES ($1)", [id(1)]);
    await pool.query("INSERT INTO identity.organizations VALUES ($1)", [id(4)]);
    await pool.query("INSERT INTO hotel_catalog.properties(id) VALUES ($1)", [id(3)]);
    await pool.query(
      "INSERT INTO identity.organization_resource_links VALUES ($1,$2,'marketplace','hotel_profile',$3,'active','owner')",
      [id(7), id(4), id(3)],
    );
  });
  return { pool: () => pool };
}
