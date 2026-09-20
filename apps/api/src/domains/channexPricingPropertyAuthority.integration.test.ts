import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Test database required");
const property = randomUUID(),
  org = randomUUID(),
  other = randomUUID(),
  jobId = randomUUID();
describe.skipIf(!url)("Channex pricing property authority on migrated PostgreSQL", () => {
  const pool = new pg.Pool({ connectionString: url });
  let client: pg.PoolClient;
  const input = { jobId, workerId: "authority-worker", attemptNumber: 1 };
  const read = () => lockChannexPricingPropertyAuthority(client, input);
  async function links(db: pg.Pool | pg.PoolClient, organization: string) {
    await db.query(
      `INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship)
      VALUES($1,'hotel_catalog','property',$2,'owner'),($1,'pms','pms_property',$2,'operator')`,
      [organization, property],
    );
  }
  beforeAll(async () => {
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Authority test')",
      [property],
    );
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Authority test',$1::text),($2::uuid,'hotel_group','Other org',$2::text)",
      [org, other],
    );
    await links(pool, org);
    await pool.query(
      "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key) VALUES($1,'pms','property-management')",
      [org],
    );
    await pool.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1::uuid,'channex',$1::text,'active','enable')",
      [property],
    );
    await pool.query(
      "INSERT INTO pms.channel_connections(property_id,provider,external_property_id,connection_status) VALUES($1::uuid,'channex',$1::text,'connected')",
      [property],
    );
    await pool.query(
      `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,status,attempts_count,locked_by,locked_at,
      tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
      VALUES($1::uuid,$1::text,'pms.channex.management','channex.sync_ari','running',1,'authority-worker',clock_timestamp(),
      'property',$2::uuid,'pms','channex_connection',$2::text,'{"operationType":"sync_ari"}')`,
      [jobId, property],
    );
    await pool.query(
      "INSERT INTO platform.job_attempts(job_id,attempt_number,worker_id) VALUES($1,1,'authority-worker')",
      [jobId],
    );
  });
  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });
  afterAll(async () => {
    await pool.query("DELETE FROM platform.job_attempts WHERE job_id=$1", [jobId]);
    await pool.query("DELETE FROM platform.jobs WHERE id=$1", [jobId]);
    await pool.query("DELETE FROM pms.channel_connections WHERE property_id=$1", [property]);
    await pool.query("DELETE FROM pms.channel_binding_claims WHERE property_id=$1", [property]);
    await pool.query("DELETE FROM identity.product_entitlements WHERE organization_id IN ($1,$2)", [
      org,
      other,
    ]);
    await pool.query(
      "DELETE FROM identity.organization_resource_links WHERE organization_id IN ($1,$2)",
      [org, other],
    );
    await pool.query("DELETE FROM identity.organizations WHERE id IN ($1,$2)", [org, other]);
    await pool.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [property]);
    await pool.end();
  });
  it("returns only database-derived authority without a user context", async () => {
    expect(await read()).toMatchObject({
      kind: "authorized",
      lease: { ...input, propertyId: property, operationType: "sync_ari" },
      organizationId: org,
      externalPropertyId: property,
    });
  });
  it.each([
    [
      "disabled property",
      "UPDATE hotel_catalog.properties SET profile_status='disabled' WHERE id=$1",
      property,
    ],
    [
      "inactive organization",
      "UPDATE identity.organizations SET status='suspended' WHERE id=$1",
      org,
    ],
    [
      "missing canonical link",
      "DELETE FROM identity.organization_resource_links WHERE organization_id=$1 AND product='hotel_catalog'",
      org,
    ],
    [
      "inactive PMS link",
      "UPDATE identity.organization_resource_links SET status='suspended' WHERE organization_id=$1 AND product='pms'",
      org,
    ],
    [
      "missing entitlement",
      "DELETE FROM identity.product_entitlements WHERE organization_id=$1",
      org,
    ],
    [
      "suspended entitlement",
      "UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1",
      org,
    ],
    [
      "expired entitlement",
      "UPDATE identity.product_entitlements SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1",
      org,
    ],
    [
      "future entitlement",
      "UPDATE identity.product_entitlements SET starts_at=clock_timestamp()+interval '1 day' WHERE organization_id=$1",
      org,
    ],
    [
      "foreign scope",
      "UPDATE identity.product_entitlements SET resource_product='pms',resource_type='pms_property',resource_id='other' WHERE organization_id=$1",
      org,
    ],
  ])("denies %s", async (_label, sql, id) => {
    await client.query(sql, [id]);
    expect(await read()).toEqual({ kind: "unavailable", reason: "scope_unavailable" });
  });
  it.each(["disconnected", "suspended"])("denies %s connections", async (status) => {
    await client.query(
      "UPDATE pms.channel_connections SET connection_status=$2 WHERE property_id=$1",
      [property, status],
    );
    expect(await read()).toEqual({ kind: "unavailable", reason: "connection_unavailable" });
  });
  it("denies nonactive claims and expired leases", async () => {
    await client.query(
      "UPDATE pms.channel_binding_claims SET claim_state='released' WHERE property_id=$1",
      [property],
    );
    expect(await read()).toEqual({ kind: "unavailable", reason: "connection_unavailable" });
    await client.query(
      "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",
      [jobId],
    );
    expect(await read()).toEqual({ kind: "unavailable", reason: "lease_unavailable" });
  });
  it("applies suspension precedence but excludes other scopes", async () => {
    await client.query(
      `INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
      VALUES($1,'pms','account_access','suspended','pms','pms_property','other')`,
      [org],
    );
    expect(await read()).toMatchObject({ kind: "authorized" });
    await client.query(
      "UPDATE identity.product_entitlements SET resource_id=$2 WHERE organization_id=$1 AND status='suspended'",
      [org, property],
    );
    expect(await read()).toEqual({ kind: "unavailable", reason: "scope_unavailable" });
  });
  it("requires serializable snapshots", async () => {
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await expect(read()).rejects.toThrow("Serializable pricing authority transaction required");
  });
  it("uses a coherent ownership snapshot and denies new ambiguity on a fresh read", async () => {
    expect(await read()).toMatchObject({ kind: "authorized" });
    try {
      await links(pool, other);
      expect(await read()).toMatchObject({ kind: "authorized", organizationId: org });
      await client.query("COMMIT");
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      expect(await read()).toEqual({ kind: "unavailable", reason: "scope_unavailable" });
    } finally {
      await client.query("ROLLBACK");
      await pool.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
        [other],
      );
    }
  });
  it("does not wait for a concurrent organization mutation", async () => {
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM identity.organizations WHERE id=$1 FOR UPDATE", [org]);
      await client.query("SET LOCAL statement_timeout='1s'");
      await expect(read()).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
  });
  it("rechecks entitlement expiry after transaction start", async () => {
    await client.query(
      "UPDATE identity.product_entitlements SET expires_at=clock_timestamp()+interval '10 milliseconds' WHERE organization_id=$1",
      [org],
    );
    await client.query("SELECT pg_sleep(0.03)");
    expect(await read()).toEqual({ kind: "unavailable", reason: "scope_unavailable" });
  });
  it("holds existing grants and observes revocation in a new transaction", async () => {
    const writer = await pool.connect();
    try {
      expect(await read()).toMatchObject({ kind: "authorized" });
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await expect(
        writer.query(
          "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES($1,'pms','account_access','suspended')",
          [org],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK");
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await expect(
        writer.query(
          "UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1",
          [org],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK");
      await client.query("COMMIT");
      await writer.query(
        "UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1",
        [org],
      );
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      expect(await read()).toEqual({ kind: "unavailable", reason: "scope_unavailable" });
    } finally {
      await client.query("ROLLBACK");
      await writer.query("ROLLBACK");
      await writer.query(
        "UPDATE identity.product_entitlements SET status='active' WHERE organization_id=$1",
        [org],
      );
      writer.release();
    }
  });
});
