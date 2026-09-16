import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("pricing authority schema", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  it("enforces tenant head identity, valid choices, request uniqueness and immutable history", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const client = await pool.connect(),
      property = randomUUID(),
      foreign = randomUUID(),
      actor = randomUUID(),
      org = randomUUID(),
      revision = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Authority schema')",
        [actor, actor + "@example.test"],
      );
      await client.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Authority schema',$2)",
        [org, org],
      );
      for (const id of [property, foreign])
        await client.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Authority schema')",
          [id],
        );
      await client.query(
        `INSERT INTO booking.pricing_authority_revisions
        (property_id,revision,authority,organization_id,actor_user_id,request_id,request_hash)
        VALUES($1,$2,'vayada',$3,$4,'request',$5)`,
        [property, revision, org, actor, "a".repeat(64)],
      );
      await client.query("INSERT INTO booking.pricing_authority_heads VALUES($1,$2)", [
        property,
        revision,
      ]);
      const invalid = [
        ["INSERT INTO booking.pricing_authority_heads VALUES($1,$2)", [foreign, revision]],
        [
          "UPDATE booking.pricing_authority_revisions SET authority='external' WHERE revision=$1",
          [revision],
        ],
        ["DELETE FROM booking.pricing_authority_revisions WHERE revision=$1", [revision]],
        ["TRUNCATE booking.pricing_authority_revisions CASCADE", []],
        [
          `INSERT INTO booking.pricing_authority_revisions
          (property_id,revision,authority,organization_id,actor_user_id,request_id,request_hash)
          VALUES($1,$2,'automatic',$3,$4,'other',$5)`,
          [property, randomUUID(), org, actor, "a".repeat(64)],
        ],
        [
          `INSERT INTO booking.pricing_authority_revisions
          (property_id,revision,authority,organization_id,actor_user_id,request_id,request_hash)
          VALUES($1,$2,'external',$3,$4,'request',$5)`,
          [property, randomUUID(), org, actor, "a".repeat(64)],
        ],
      ] as const;
      for (const [sql, values] of invalid) {
        await client.query("SAVEPOINT invalid");
        await expect(client.query(sql, [...values])).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT invalid");
      }
      expect(
        (
          await client.query(
            "SELECT authority FROM booking.pricing_authority_revisions WHERE property_id=$1",
            [property],
          )
        ).rows,
      ).toEqual([{ authority: "vayada" }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
