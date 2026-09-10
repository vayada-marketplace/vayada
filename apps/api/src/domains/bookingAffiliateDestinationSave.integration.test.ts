import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveBookingAffiliateDestinationFromMarketplace as save } from "./bookingAffiliateDestinationSave.js";
const databaseUrl = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `15100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const platform = await readFile(new URL("0010_platform_jobs_events_audit.sql", migrations), "utf8");
const destinations = await readFile(
  new URL("0179_booking_affiliate_destinations.sql", migrations),
  "utf8",
);
function context(): RequestContext {
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

describe.skipIf(!databaseUrl)("affiliate destination save (PostgreSQL)", () => {
  const name = `vay1510_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let pool: pg.Pool;
  let isolatedUrl: string;
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl!).pathname.slice(1)))
      throw new Error("Requires isolated test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    isolatedUrl = url.toString();
    pool = new pg.Pool({ connectionString: isolatedUrl, max: 3 });
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS booking,platform,identity,hotel_catalog CASCADE;
      CREATE SCHEMA booking; CREATE SCHEMA platform; CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog;
      CREATE TABLE identity.users(id UUID PRIMARY KEY); CREATE TABLE identity.organizations(id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY, profile_status TEXT DEFAULT 'incomplete');
      CREATE TABLE identity.organization_resource_links(id UUID PRIMARY KEY, organization_id UUID, product TEXT,
        resource_type TEXT, resource_id TEXT, status TEXT, relationship TEXT);`);
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
    await pool.query(destinations);
    await pool.query("INSERT INTO identity.users VALUES ($1),($2)", [id(1), id(9)]);
    await pool.query("INSERT INTO identity.organizations VALUES ($1),($2)", [id(4), id(5)]);
    await pool.query("INSERT INTO hotel_catalog.properties(id) VALUES ($1),($2)", [id(3), id(6)]);
    await pool.query(
      `INSERT INTO identity.organization_resource_links VALUES ($1,$2,'marketplace','hotel_profile',$3,'active','owner')`,
      [id(7), id(4), id(3)],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const input = () => ({
    context: context(),
    propertyId: id(3),
    idempotencyKey: "save-1",
    configuration: {
      displayName: "Hotel bookings",
      bookingUrl: "https://booking.example.com/?hotel=42",
    },
  });
  it("saves immutable versions and replays without replacing the first URL", async () => {
    const first = await save(pool, input());
    const second = await save(pool, {
      ...input(),
      idempotencyKey: "next",
      configuration: { ...input().configuration, bookingUrl: "https://other.example.com" },
    });
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: false });
    await expect(save(pool, input())).resolves.toEqual({ ...first, replayed: true });
    const rows = await pool.query(
      "SELECT booking_url,created_by_user_id,request_id FROM booking.affiliate_destination_versions ORDER BY booking_url",
    );
    expect(rows.rows.map((r) => r.booking_url)).toEqual([
      input().configuration.bookingUrl,
      "https://other.example.com/",
    ]);
    expect(rows.rows[0]).toMatchObject({ created_by_user_id: id(1), request_id: "request-1" });
    for (const sql of [
      "UPDATE booking.affiliate_destination_versions SET display_name='changed'",
      "DELETE FROM booking.affiliate_destination_versions",
      "TRUNCATE booking.affiliate_destination_versions",
    ])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "55000" });
  });
  it("serializes duplicate saves and rejects a changed payload under the same key", async () => {
    const results = await Promise.all([save(pool, input()), save(pool, input())]);
    expect(results.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    await expect(
      save(pool, {
        ...input(),
        configuration: { ...input().configuration, displayName: "Changed" },
      }),
    ).resolves.toMatchObject({ code: "idempotency_conflict" });
  });
  it("rechecks permission, entitlement and resource access before replay", async () => {
    await save(pool, input());
    for (const mutate of [
      (c: RequestContext) => {
        c.membership.permissions = [];
      },
      (c: RequestContext) => {
        c.entitlements = [];
      },
      (c: RequestContext) => {
        c.linkedResources = [];
      },
    ]) {
      const command = input();
      mutate(command.context);
      await expect(save(pool, command)).rejects.toThrow();
    }
    await pool.query("UPDATE identity.organization_resource_links SET status='revoked'");
    await expect(save(pool, input())).resolves.toMatchObject({ code: "scope_unavailable" });
  });
  it("rejects other hotel scope and a disabled property", async () => {
    await expect(
      save(pool, {
        ...input(),
        context: {
          ...context(),
          selectedOrganization: { ...context().selectedOrganization, organizationId: id(5) },
        },
      }),
    ).resolves.toMatchObject({ code: "scope_unavailable" });
    await pool.query("UPDATE hotel_catalog.properties SET profile_status='disabled'");
    await expect(save(pool, input())).resolves.toMatchObject({ code: "scope_unavailable" });
  });
  it("rejects invalid configuration and rolls back when idempotency persistence fails", async () => {
    await expect(
      save(pool, { ...input(), configuration: { ...input().configuration, verified: true } }),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await pool.query(`CREATE FUNCTION platform.fail_destination_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER fail_destination_test BEFORE INSERT ON platform.idempotency_keys FOR EACH ROW EXECUTE FUNCTION platform.fail_destination_test()`);
    await expect(save(pool, input())).rejects.toThrow("test failure");
    expect(
      (await pool.query("SELECT count(*) FROM booking.affiliate_destination_versions")).rows[0]
        .count,
    ).toBe("0");
  });
});
