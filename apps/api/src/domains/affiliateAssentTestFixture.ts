import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { beforeEach } from "vitest";
import { id, publicationFixture } from "./affiliatePublicationTestFixture.js";
export const disclosure = JSON.stringify({
  contractVersion: "marketplace-published-affiliate-terms.v1",
  terms: {
    bookingDestinationId: id(30),
    financePolicyVersionId: "policy-1",
    attributionWindowDays: 14,
  },
  commission: "12.50%",
});
export const disclosureHash = createHash("sha256").update(disclosure).digest("hex");
export function assentFixture() {
  const fixture = publicationFixture();
  beforeEach(async () => {
    const pool = fixture.pool();
    await pool.query(`CREATE TABLE identity.organizations(id UUID PRIMARY KEY);
      CREATE TABLE marketplace.creator_profiles(id UUID PRIMARY KEY, organization_id UUID,
        owner_user_id UUID, profile_status TEXT DEFAULT 'active', UNIQUE(id, organization_id));
      INSERT INTO identity.organizations VALUES ('${id(4)}'),('${id(7)}'),('${id(80)}');
      INSERT INTO identity.users VALUES ('${id(81)}');
      INSERT INTO marketplace.creator_profiles VALUES ('${id(82)}','${id(80)}','${id(81)}','active');`);
    await pool.query(
      await readFile(
        new URL(
          "../../../../packages/backend-migration/migrations/0197_marketplace_affiliate_initial_assent.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await fixture.draft(id(21), 2);
    await fixture.draft(id(22), 1, id(5), id(6), id(7));
    for (const [termsId, programId, offerId, propertyId, organizationId, draftId] of [
      [id(51), id(50), id(2), id(3), id(4), id(20)],
      [id(52), id(50), id(2), id(3), id(4), id(21)],
      [id(61), id(60), id(5), id(6), id(7), id(22)],
    ])
      await pool.query(
        `INSERT INTO marketplace.affiliate_published_terms
      (id,program_id,offer_id,property_id,organization_id,source_draft_id,disclosure,disclosure_hash,
       attribution_policy_version,evidence_references,actor_user_id,request_id,effective_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'synthetic-v1','["synthetic-evidence"]',$9,'fixture',now())`,
        [
          termsId,
          programId,
          offerId,
          propertyId,
          organizationId,
          draftId,
          disclosure,
          disclosureHash,
          id(1),
        ],
      );
  });
  return fixture;
}
