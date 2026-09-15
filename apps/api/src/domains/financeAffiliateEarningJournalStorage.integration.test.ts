import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const databaseUrl = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `15100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = await readFile(
  new URL("0195_finance_affiliate_earning_journal.sql", migrations),
  "utf8",
);
const platform = await readFile(new URL("0010_platform_jobs_events_audit.sql", migrations), "utf8");
describe.skipIf(!databaseUrl)("affiliate earning journal storage", () => {
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
    pool = new pg.Pool({ connectionString: url.toString() });
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
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY);`);
    await pool.query(
      platform.slice(
        platform.indexOf("CREATE FUNCTION platform.prevent_append_only_mutation()"),
        platform.indexOf("CREATE TABLE platform.domain_events ("),
      ),
    );
    await pool.query(migration);
    await pool.query("INSERT INTO identity.users VALUES ($1)", [id(1)]);
    await pool.query("INSERT INTO identity.organizations VALUES ($1)", [id(4)]);
    await pool.query("INSERT INTO hotel_catalog.properties VALUES ($1)", [id(3)]);
    await pool.query(
      `INSERT INTO finance.affiliate_earning_journal
      (id,property_id,booking_id,stay_item_id,revision,source_revision,input_digest,calculation_input,outcome,actor_user_id,organization_id,request_id)
      VALUES ($1,$2,'booking','item',1,1,$3,'{}','{"status":"pending"}',$4,$5,'test')`,
      [id(60), id(3), "a".repeat(64), id(1), id(4)],
    );
  });
  it("prevents mutation and duplicate source or journal revisions", async () => {
    for (const sql of [
      "UPDATE finance.affiliate_earning_journal SET revision=2",
      "DELETE FROM finance.affiliate_earning_journal",
      "TRUNCATE finance.affiliate_earning_journal",
    ])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "55000" });
    for (const [revision, source] of [
      [1, 2],
      [2, 1],
    ])
      await expect(
        pool.query(
          `INSERT INTO finance.affiliate_earning_journal
        SELECT $1,property_id,booking_id,stay_item_id,$2,$3,input_digest,calculation_input,outcome,actor_user_id,organization_id,request_id,recorded_at
        FROM finance.affiliate_earning_journal`,
          [id(61), revision, source],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    expect(
      (await pool.query("SELECT count(*) FROM finance.affiliate_earning_journal")).rows[0].count,
    ).toBe("1");
  });
  it("appends unresolved outcomes without replacing earlier calculation history", async () => {
    for (const [revision, outcome] of [
      [2, { status: "calculated", snapshot: { commissionMinor: "5000" } }],
      [3, { status: "needs_review", reason: "conflicting_evidence" }],
    ] as const)
      await pool.query(
        `INSERT INTO finance.affiliate_earning_journal
        SELECT $1,property_id,booking_id,stay_item_id,$2::integer,$2::integer,input_digest,calculation_input,$3,
          actor_user_id,organization_id,request_id,recorded_at
        FROM finance.affiliate_earning_journal WHERE revision=1`,
        [randomUUID(), revision, outcome],
      );
    expect(
      (
        await pool.query(
          "SELECT outcome->>'status' AS status FROM finance.affiliate_earning_journal ORDER BY revision",
        )
      ).rows.map((row) => row.status),
    ).toEqual(["pending", "calculated", "needs_review"]);
  });
  it.each([
    ["property_id", id(99), "23503"],
    ["actor_user_id", id(99), "23503"],
    ["organization_id", id(99), "23503"],
    ["booking_id", "booking/other", "23514"],
    ["stay_item_id", "", "23514"],
    ["revision", 0, "23514"],
    ["source_revision", "9007199254740992", "23514"],
    ["input_digest", "invalid", "23514"],
    ["calculation_input", "[]", "23514"],
    ["outcome", '{"status":"paid"}', "23514"],
    ["request_id", " ", "23514"],
    ["recorded_at", "infinity", "23514"],
  ])("rejects invalid %s without appending a row", async (column, value, code) => {
    const columns = [
      "property_id",
      "booking_id",
      "stay_item_id",
      "revision",
      "source_revision",
      "input_digest",
      "calculation_input",
      "outcome",
      "actor_user_id",
      "organization_id",
      "request_id",
      "recorded_at",
    ];
    const expressions = columns.map((name) =>
      name === column ? "$2" : name === "revision" || name === "source_revision" ? "2" : name,
    );
    await expect(
      pool.query(
        `INSERT INTO finance.affiliate_earning_journal (id,${columns.join(",")})
       SELECT $1,${expressions.join(",")} FROM finance.affiliate_earning_journal WHERE revision=1`,
        [randomUUID(), value],
      ),
    ).rejects.toMatchObject({ code });
    expect(
      (await pool.query("SELECT count(*) FROM finance.affiliate_earning_journal")).rows[0].count,
    ).toBe("1");
  });
});
