import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { databaseUrl, id, publicationFixture } from "./affiliatePublicationTestFixture.js";
const migration = await readFile(
  new URL(
    "../../../../packages/backend-migration/migrations/0182_finance_affiliate_earning_journal.sql",
    import.meta.url,
  ),
  "utf8",
);
describe.skipIf(!databaseUrl)("affiliate earning journal storage", () => {
  const fixture = publicationFixture();
  beforeEach(async () => {
    await fixture.pool().query(migration);
    await fixture.pool().query(
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
      await expect(fixture.pool().query(sql)).rejects.toThrow();
    for (const [revision, source] of [
      [1, 2],
      [2, 1],
    ])
      await expect(
        fixture.pool().query(
          `INSERT INTO finance.affiliate_earning_journal
        SELECT $1,property_id,booking_id,stay_item_id,$2,$3,input_digest,calculation_input,outcome,actor_user_id,organization_id,request_id,recorded_at
        FROM finance.affiliate_earning_journal`,
          [id(61), revision, source],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    expect(
      (await fixture.pool().query("SELECT count(*) FROM finance.affiliate_earning_journal")).rows[0]
        .count,
    ).toBe("1");
  });
});
