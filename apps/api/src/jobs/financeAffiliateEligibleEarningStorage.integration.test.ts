import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const root = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const journalSql = await readFile(
  new URL("0195_finance_affiliate_earning_journal.sql", root),
  "utf8",
);
const earningSql = await readFile(
  new URL("0425_finance_affiliate_eligible_earnings.sql", root),
  "utf8",
);
const id = (n: number) => `15110000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!databaseUrl)("eligible affiliate earning storage", () => {
  const databaseName = `vay1511_earning_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl!).pathname.slice(1)))
      throw new Error("Requires isolated test database");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString() });
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${databaseName}`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS finance,platform,identity,hotel_catalog,booking,pms,marketplace CASCADE;
      CREATE SCHEMA finance; CREATE SCHEMA platform; CREATE SCHEMA identity;
      CREATE SCHEMA hotel_catalog; CREATE SCHEMA booking; CREATE SCHEMA pms; CREATE SCHEMA marketplace;
      CREATE FUNCTION platform.prevent_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Append-only records cannot be mutated' USING ERRCODE='55000'; END $$;
      CREATE TABLE identity.users(id UUID PRIMARY KEY);
      CREATE TABLE identity.organizations(id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY);
      CREATE TABLE booking.guest_bookings(id UUID,property_id UUID,PRIMARY KEY(id,property_id));
      CREATE TABLE pms.operational_booking_assignments(id UUID,property_id UUID,guest_booking_id UUID,
        PRIMARY KEY(id),UNIQUE(id,property_id,guest_booking_id));
      CREATE TABLE marketplace.creator_profiles(id UUID,organization_id UUID,PRIMARY KEY(id),UNIQUE(id,organization_id));
      CREATE TABLE marketplace.affiliate_agreements(id UUID PRIMARY KEY);
      CREATE TABLE finance.affiliate_percentage_policy_versions(id UUID PRIMARY KEY);`);
    await pool.query(journalSql);
    await pool.query(earningSql);
    await pool.query(
      `INSERT INTO identity.users VALUES($1); INSERT INTO identity.organizations VALUES($2),($3);
       INSERT INTO hotel_catalog.properties VALUES($4);
       INSERT INTO booking.guest_bookings VALUES($5,$4);
       INSERT INTO pms.operational_booking_assignments VALUES($6,$4,$5);
       INSERT INTO marketplace.creator_profiles VALUES($7,$2);
       INSERT INTO marketplace.affiliate_agreements VALUES($8);
       INSERT INTO finance.affiliate_percentage_policy_versions VALUES($9)`,
      [id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8), id(9)],
    );
  });

  it("keeps reconciliation and eligible handoff revisions immutable and deduplicated", async () => {
    const entryId = id(10);
    await pool.query(
      `INSERT INTO finance.affiliate_earning_reconciliation_revisions
       (id,property_id,booking_id,stay_item_id,revision,evidence_digest,calculation_input,
        creator_profile_id,affiliate_id,beneficiary_organization_id,actor_user_id,hotel_organization_id)
       VALUES($1,$2,$3,$4,1,$5,'{}',$6,'affiliate-1',$7,$8,$9)`,
      [id(11), id(4), id(5), id(6), "a".repeat(64), id(7), id(2), id(1), id(3)],
    );
    await pool.query(
      `INSERT INTO finance.affiliate_earning_journal
       (id,property_id,booking_id,stay_item_id,revision,source_revision,input_digest,
        calculation_input,outcome,actor_user_id,organization_id,request_id)
       VALUES($1,$2,$3,$4,1,1,$5,'{}','{"status":"calculated"}',$6,$7,'test')`,
      [entryId, id(4), id(5), id(6), "b".repeat(64), id(1), id(3)],
    );
    await pool.query(
      `INSERT INTO finance.affiliate_eligible_earning_revisions
       (earning_entry_id,contract_version,property_id,booking_id,stay_item_id,agreement_id,
        policy_version_id,source_revision,creator_profile_id,affiliate_id,
        beneficiary_organization_id,currency,currency_minor_unit,commission_minor,adjustment_minor,status)
       VALUES($1,'finance-affiliate-settlement-entry.v1',$2,$3,$4,$5,$6,1,$7,'affiliate-1',$8,'EUR',2,3625,3625,'eligible')`,
      [entryId, id(4), id(5), id(6), id(8), id(9), id(7), id(2)],
    );
    for (const table of [
      "finance.affiliate_earning_reconciliation_revisions",
      "finance.affiliate_eligible_earning_revisions",
    ]) {
      await expect(
        pool.query(`UPDATE ${table} SET recorded_at=clock_timestamp()`),
      ).rejects.toMatchObject({
        code: "55000",
      });
      await expect(pool.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "55000" });
    }
    await expect(
      pool.query(
        `INSERT INTO finance.affiliate_earning_reconciliation_revisions
         SELECT $1,property_id,booking_id,stay_item_id,2,evidence_digest,calculation_input,
          creator_profile_id,affiliate_id,beneficiary_organization_id,actor_user_id,hotel_organization_id,recorded_at
         FROM finance.affiliate_earning_reconciliation_revisions`,
        [id(12)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
