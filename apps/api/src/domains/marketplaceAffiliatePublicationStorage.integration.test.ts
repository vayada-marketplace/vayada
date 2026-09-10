import { randomUUID, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { context, databaseUrl, id, publicationFixture, terms } from "./affiliatePublicationTestFixture.js";
import { saveMarketplaceAffiliateDraft } from "./marketplaceAffiliateDraftCommand.js";

describe.skipIf(!databaseUrl)("published affiliate terms storage", () => {
  const fixture = publicationFixture();
  async function insert() {
    const pool = fixture.pool();
    const draft = await saveMarketplaceAffiliateDraft(pool, { context: context(), propertyId: id(3),
      offerId: id(2), expectedRevision: 0, idempotencyKey: "draft", terms });
    if (!draft.ok) throw new Error(draft.code);
    await pool.query("INSERT INTO marketplace.affiliate_programs VALUES ($1,$2,$3,$4)", [id(50),id(2),id(3),id(4)]);
    await pool.query(`INSERT INTO marketplace.affiliate_published_terms
      (id,program_id,offer_id,property_id,organization_id,source_draft_id,disclosure,disclosure_hash,
       attribution_policy_version,evidence_references,actor_user_id,request_id,effective_at)
      VALUES ($1,$2,$3,$4,$5,$6,'{"fixture":true}',$7,'test-policy','["test-evidence"]',$8,'test',clock_timestamp())`,
      [id(51),id(50),id(2),id(3),id(4),draft.draftId,createHash("sha256").update('{"fixture":true}').digest("hex"),id(1)]);
  }
  it("preserves the exact draft and enforces immutable publication/program records", async () => {
    await insert();
    const pool = fixture.pool();
    for (const table of ["affiliate_programs", "affiliate_published_terms"]) {
      await expect(pool.query(`UPDATE marketplace.${table} SET id=$1`,[randomUUID()])).rejects.toThrow();
      await expect(pool.query(`DELETE FROM marketplace.${table}`)).rejects.toThrow();
      await expect(pool.query(`TRUNCATE marketplace.${table} CASCADE`)).rejects.toThrow();
      expect((await pool.query(`SELECT count(*) FROM marketplace.${table}`)).rows[0].count).toBe("1");
    }
    await expect(pool.query("DELETE FROM marketplace.affiliate_offer_terms_drafts")).rejects.toThrow();
  });
  it("rejects cross-property publication and duplicate publication of a draft", async () => {
    await insert();
    for (const property of [id(6),id(3)]) {
      await expect(fixture.pool().query(`INSERT INTO marketplace.affiliate_published_terms
        SELECT $1,program_id,offer_id,$2,organization_id,source_draft_id,disclosure,disclosure_hash,
        attribution_policy_version,evidence_references,actor_user_id,request_id,effective_at,recorded_at
        FROM marketplace.affiliate_published_terms`, [randomUUID(),property])).rejects.toThrow();
    }
  });
});
