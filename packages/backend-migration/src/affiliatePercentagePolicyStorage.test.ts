import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const migration = await readFile(
  new URL("../migrations/0180_finance_affiliate_percentage_policies.sql", import.meta.url),
  "utf8",
);
const platform = await readFile(
  new URL("../migrations/0010_platform_jobs_events_audit.sql", import.meta.url),
  "utf8",
);
const id = (n: number) => `15100000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!databaseUrl)("affiliate percentage policy storage (PostgreSQL)", () => {
  const name = `vay1510_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(databaseUrl!);
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(`CREATE SCHEMA finance; CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog; CREATE SCHEMA platform;
      CREATE TABLE identity.users(id UUID PRIMARY KEY); CREATE TABLE identity.organizations(id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY);`);
    await client.query(
      platform.slice(
        platform.indexOf("CREATE FUNCTION platform.prevent_append_only_mutation()"),
        platform.indexOf("CREATE TABLE platform.domain_events ("),
      ),
    );
    await client.query(migration);
    await client.query("INSERT INTO identity.users VALUES ($1)", [id(1)]);
    await client.query("INSERT INTO identity.organizations VALUES ($1)", [id(2)]);
    await client.query("INSERT INTO hotel_catalog.properties VALUES ($1),($2)", [id(3), id(4)]);
    await client.query("BEGIN");
  });
  beforeEach(async () => {
    await client.query("ROLLBACK; BEGIN");
  });
  afterAll(async () => {
    await client?.end();
    if (client) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  async function rejected(action: () => Promise<unknown>, code: string) {
    await client.query("SAVEPOINT bad");
    await expect(action()).rejects.toMatchObject({ code });
    await client.query("ROLLBACK TO SAVEPOINT bad");
  }
  function version(rate: number | null = 1000, versionId = id(10)) {
    return client.query(
      `INSERT INTO finance.affiliate_percentage_policy_versions
      (id,property_id,contract_version,model,revenue_basis,eligibility,rate_basis_points,created_by_user_id,created_by_organization_id,request_id)
      VALUES($1,$2,'finance-affiliate-percentage-policy.v1','percentage','accommodation_excluding_taxes_and_extras','verified_completion',$3,$4,$5,'test-request')`,
      [versionId, id(3), rate, id(1), id(2)],
    );
  }
  function approve(property = id(3), versionId = id(10)) {
    return client.query(
      `INSERT INTO finance.affiliate_percentage_policy_approvals
      (policy_version_id,property_id,approved_by_user_id,approved_by_organization_id,request_id) VALUES($1,$2,$3,$4,'approve-test')`,
      [versionId, property, id(1), id(2)],
    );
  }
  it("keeps old approved rates unchanged when a newer rate is added", async () => {
    await version();
    expect(
      (await client.query("SELECT count(*) FROM finance.affiliate_percentage_policy_approvals"))
        .rows[0].count,
    ).toBe("0");
    await approve();
    await version(2000, id(11));
    const rates = await client.query(
      "SELECT rate_basis_points FROM finance.affiliate_percentage_policy_versions ORDER BY id",
    );
    expect(rates.rows).toEqual([{ rate_basis_points: 1000 }, { rate_basis_points: 2000 }]);
    await rejected(() => approve(), "23505");
  });
  it("rejects missing rates and invalid bounds while retaining exact endpoints", async () => {
    await rejected(() => version(null), "23502");
    for (const rate of [-1, 10001]) await rejected(() => version(rate), "23514");
    await version(0);
    await version(10000, id(11));
  });
  it("rejects approval of a missing version or another hotel", async () => {
    await rejected(() => approve(), "23503");
    await version();
    await rejected(() => approve(id(4)), "23503");
    await approve();
  });
  it("protects both histories from edits, deletion and truncation", async () => {
    await version();
    await approve();
    for (const table of [
      "affiliate_percentage_policy_versions",
      "affiliate_percentage_policy_approvals",
    ])
      for (const sql of [
        `UPDATE finance.${table} SET request_id='changed'`,
        `DELETE FROM finance.${table}`,
        `TRUNCATE finance.${table} CASCADE`,
      ])
        await rejected(() => client.query(sql), "55000");
  });
  it("requires real author identities and the fixed approved model", async () => {
    await version();
    const clone = (column: string, value: string) =>
      client.query(
        `INSERT INTO finance.affiliate_percentage_policy_versions
      SELECT $1,property_id,contract_version,${column === "model" ? "$2" : "model"},revenue_basis,eligibility,rate_basis_points,
      ${column === "created_by_user_id" ? "$2::uuid" : "created_by_user_id"},created_by_organization_id,request_id,recorded_at
      FROM finance.affiliate_percentage_policy_versions WHERE id=$3`,
        [id(11), value, id(10)],
      );
    await rejected(() => clone("model", "fixed"), "23514");
    await rejected(() => clone("created_by_user_id", id(99)), "23503");
  });
});
