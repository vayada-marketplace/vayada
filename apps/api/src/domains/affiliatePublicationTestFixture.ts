import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";

export const databaseUrl = process.env["TEST_DATABASE_URL"];
export const id = (n: number) => `15010000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);

// Synthetic storage rows only: no publication command or authorization is exercised.
export function publicationFixture() {
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
    pool = new pg.Pool({ connectionString: isolatedUrl.toString() });
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS marketplace,identity CASCADE;
      CREATE SCHEMA marketplace; CREATE SCHEMA identity;
      CREATE TABLE identity.users(id UUID PRIMARY KEY);
      CREATE TABLE marketplace.marketplace_offers(id UUID PRIMARY KEY, property_id UUID, organization_id UUID,
        UNIQUE(id,property_id,organization_id));`);
    await pool.query(
      await readFile(
        new URL("0173_marketplace_affiliate_offer_terms_drafts.sql", migrations),
        "utf8",
      ),
    );
    await pool.query("INSERT INTO identity.users VALUES ($1)", [id(1)]);
    await pool.query("INSERT INTO marketplace.marketplace_offers VALUES ($1,$2,$3),($4,$5,$6)", [
      id(2),
      id(3),
      id(4),
      id(5),
      id(6),
      id(7),
    ]);
    await draft(id(20));
    // Upgrade with an existing immutable draft; publication must preserve its source row.
    await pool.query(
      await readFile(new URL("0196_marketplace_published_affiliate_terms.sql", migrations), "utf8"),
    );
    await pool.query(
      "INSERT INTO marketplace.affiliate_programs VALUES ($1,$2,$3,$4),($5,$6,$7,$8)",
      [id(50), id(2), id(3), id(4), id(60), id(5), id(6), id(7)],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${databaseName}`);
    await admin.end();
  });
  async function draft(
    draftId: string,
    revision = 1,
    offerId = id(2),
    propertyId = id(3),
    organizationId = id(4),
  ) {
    await pool.query(
      `INSERT INTO marketplace.affiliate_offer_terms_drafts
      (id,offer_id,property_id,organization_id,revision,contract_version,booking_destination_id,
       finance_policy_version_id,attribution_window_days,actor_user_id,request_id)
      VALUES ($1,$2,$3,$4,$5,'marketplace-affiliate-offer-terms.v1',$7,'policy-1',14,$6,'fixture')`,
      [draftId, offerId, propertyId, organizationId, revision, id(1), id(30)],
    );
  }
  return { pool: () => pool, draft };
}
