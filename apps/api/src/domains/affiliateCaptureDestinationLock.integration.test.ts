import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AFFILIATE_CAPTURE_ROLE } from "./affiliateCaptureRoleBoundary.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");

describe.skipIf(!url)("affiliate destination lock boundary (PostgreSQL)", () => {
  const owner = new pg.Client({ connectionString: url });
  const propertyId = randomUUID();
  const slugId = randomUUID();

  beforeAll(async () => {
    await owner.connect();
    await owner.query(
      `CREATE ROLE ${AFFILIATE_CAPTURE_ROLE}
       LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await owner.query(`GRANT USAGE ON SCHEMA hotel_catalog TO ${AFFILIATE_CAPTURE_ROLE}`);
    await owner.query(
      `GRANT SELECT,UPDATE ON hotel_catalog.properties,hotel_catalog.property_slugs
       TO ${AFFILIATE_CAPTURE_ROLE}`,
    );
    await owner.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name)
       VALUES($1,$2,'Affiliate destination lock fixture')`,
      [propertyId, `affiliate-lock-${propertyId}`],
    );
    await owner.query(
      `INSERT INTO hotel_catalog.property_slugs(id,property_id,slug,purpose)
       VALUES($1,$2,$3,'canonical')`,
      [slugId, propertyId, `affiliate-lock-${slugId}`],
    );
  });

  afterAll(async () => {
    await owner.query("DELETE FROM hotel_catalog.property_slugs WHERE id=$1", [slugId]);
    await owner.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    await owner.query(
      `DROP OWNED BY ${AFFILIATE_CAPTURE_ROLE}; DROP ROLE ${AFFILIATE_CAPTURE_ROLE}`,
    );
    await owner.end();
  });

  it("permits destination row locks while rejecting catalogue mutations", async () => {
    await owner.query("BEGIN");
    try {
      await owner.query(`SET LOCAL ROLE ${AFFILIATE_CAPTURE_ROLE}`);
      await expect(
        owner.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR SHARE", [propertyId]),
      ).resolves.toHaveProperty("rowCount", 1);
      await expect(
        owner.query("SELECT id FROM hotel_catalog.property_slugs WHERE id=$1 FOR SHARE", [slugId]),
      ).resolves.toHaveProperty("rowCount", 1);
    } finally {
      await owner.query("ROLLBACK");
    }

    for (const [statement, value] of [
      ["UPDATE hotel_catalog.properties SET display_name='forged' WHERE id=$1", propertyId],
      ["UPDATE hotel_catalog.property_slugs SET slug='forged' WHERE id=$1", slugId],
    ] as const) {
      await owner.query("BEGIN");
      try {
        await owner.query(`SET LOCAL ROLE ${AFFILIATE_CAPTURE_ROLE}`);
        await expect(owner.query(statement, [value])).rejects.toThrow(/row-level security/i);
      } finally {
        await owner.query("ROLLBACK");
      }
    }
  });
});
