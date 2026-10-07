import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgAffiliateDiscrepancyRepository } from "./affiliateDiscrepancyRepository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const u = (suffix: string) => `15160000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const creatorOrganizationId = u("1");
const hotelOrganizationId = u("2");
const creatorProfileId = u("3");
const propertyId = u("4");
const agreementId = u("5");
const bookingId = u("6");
const actorUserId = u("7");
const termsId = u("8");
const linkId = u("9");
const clickId = u("10");
const contextId = u("11");
const earningEntryId = u("30");
const wrongAffiliateEarningId = u("31");
const payoutId = u("32");
const unpaidPayoutId = u("33");
const wrongAffiliatePayoutId = u("34");
const paymentEvidenceId = u("35");
const affiliateId = "affiliate-vay-1516";

describe.skipIf(!databaseUrl)("PostgreSQL affiliate discrepancy repository", () => {
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const repository = createPgAffiliateDiscrepancyRepository(
    databaseUrl ?? "postgresql://integration-test-disabled",
  );
  const scope = { organizationId: creatorOrganizationId, creatorProfileId, affiliateId };

  beforeAll(async () => {
    assertSafeTestDatabase(databaseUrl!);
    await seed();
  });

  afterAll(async () => {
    await repository.close();
    await admin.end();
  });

  it("replays exact duplicates while retaining first evidence and creator isolation", async () => {
    const first = await repository.submit(command("booking_attribution", "first-evidence"));
    const duplicate = await repository.submit(command("booking_attribution", "later-evidence"));
    expect(first.replayed).toBe(false);
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.claim.claimId).toBe(first.claim.claimId);
    expect(duplicate.claim.evidenceReferences).toEqual(["first-evidence"]);
    expect(duplicate.claim.bookingReference).toBe(`••••${bookingId.slice(-4)}`);

    const otherScope = { ...scope, organizationId: u("99") };
    expect(await repository.list(otherScope)).toEqual([]);
    expect(await repository.get(otherScope, first.claim.claimId)).toBeNull();
  });

  it("serializes property-scoped decisions and rejects evidence-free commission", async () => {
    const submitted = await repository.submit(command("earning", "earning-claim"));
    const decision = {
      claimId: submitted.claim.claimId,
      propertyId,
      resolution: {
        decision: "denied" as const,
        reason: "No eligible earning evidence",
        evidenceReferences: ["review-evidence"],
        earningEntryId: null,
        payoutId: null,
      },
      idempotencyKey: "resolution-1516",
      actorUserId,
      actorOrganizationId: hotelOrganizationId,
      requestId: "request-resolution-1516",
    };
    expect(await repository.resolve({ ...decision, propertyId: u("404") })).toEqual({
      ok: false,
      code: "not_found",
    });
    const concurrent = await Promise.all([
      repository.resolve(decision),
      repository.resolve(decision),
    ]);
    expect(concurrent.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(concurrent.filter((result) => result.ok && result.replayed)).toHaveLength(1);
    expect(
      await repository.resolve({
        ...decision,
        resolution: { ...decision.resolution, reason: "Changed reason" },
      }),
    ).toEqual({ ok: false, code: "idempotency_conflict" });

    const unsupported = await repository.submit(command("payment", "payment-claim"));
    await expect(
      repository.resolve({
        ...decision,
        claimId: unsupported.claim.claimId,
        idempotencyKey: "unsupported-earning-1516",
        resolution: {
          decision: "confirmed_earning",
          reason: "No matching Finance evidence exists",
          evidenceReferences: ["review-evidence"],
          earningEntryId: u("700"),
          payoutId: null,
        },
      }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      repository.submit({
        ...command("payment", "wrong-affiliate-payout"),
        payoutId: wrongAffiliatePayoutId,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    const attribution = await repository.submit(command("booking_attribution", "scope-claim"));
    await expect(
      repository.resolve({
        ...decision,
        claimId: attribution.claim.claimId,
        idempotencyKey: "unpaid-payout-1516",
        resolution: {
          decision: "confirmed_payment",
          reason: "Allocation exists without payment evidence",
          evidenceReferences: ["review-evidence"],
          earningEntryId,
          payoutId: unpaidPayoutId,
        },
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const payable = await repository.submit({
      ...command("payment", "paid-payout"),
      payoutId,
    });
    const paid = await repository.resolve({
      ...decision,
      claimId: payable.claim.claimId,
      idempotencyKey: "paid-payout-1516",
      resolution: {
        decision: "confirmed_payment",
        reason: "Finance payment evidence matches",
        evidenceReferences: ["payment-evidence-1516"],
        earningEntryId,
        payoutId,
      },
    });
    expect(paid.ok && paid.claim.status).toBe("confirmed_payment");
  });

  function command(kind: "booking_attribution" | "earning" | "payment", evidence: string) {
    return {
      scope,
      kind,
      agreementId,
      propertyId,
      bookingId,
      payoutId: null,
      message: `Claim ${kind}`,
      evidenceReferences: [evidence],
      actorUserId,
      requestId: `request-${kind}`,
    };
  }

  async function seed() {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      const statements: Array<[string, unknown[]]> = [
        [
          "DELETE FROM finance.affiliate_payout_payment_evidence_items WHERE payout_id IN ($1,$2,$3)",
          [payoutId, unpaidPayoutId, wrongAffiliatePayoutId],
        ],
        ["DELETE FROM finance.affiliate_payout_payment_evidence WHERE id=$1", [paymentEvidenceId]],
        [
          "DELETE FROM finance.affiliate_earning_allocation_items WHERE earning_entry_id IN ($1,$2)",
          [earningEntryId, wrongAffiliateEarningId],
        ],
        [
          "DELETE FROM finance.affiliate_earning_allocations WHERE earning_entry_id IN ($1,$2)",
          [earningEntryId, wrongAffiliateEarningId],
        ],
        [
          "DELETE FROM finance.affiliate_eligible_earning_revisions WHERE earning_entry_id IN ($1,$2)",
          [earningEntryId, wrongAffiliateEarningId],
        ],
        [
          "DELETE FROM finance.payouts WHERE id IN ($1,$2,$3)",
          [payoutId, unpaidPayoutId, wrongAffiliatePayoutId],
        ],
        [
          `DELETE FROM marketplace.affiliate_discrepancy_resolutions WHERE claim_id IN
             (SELECT id FROM marketplace.affiliate_discrepancy_claims WHERE creator_organization_id=$1)`,
          [creatorOrganizationId],
        ],
        [
          "DELETE FROM marketplace.affiliate_discrepancy_claims WHERE creator_organization_id=$1",
          [creatorOrganizationId],
        ],
        [
          "DELETE FROM booking.affiliate_original_booking_bindings WHERE booking_id=$1",
          [bookingId],
        ],
        ["DELETE FROM booking.affiliate_click_admissions WHERE context_id=$1", [contextId]],
        ["DELETE FROM booking.affiliate_click_contexts WHERE id=$1", [contextId]],
        ["DELETE FROM marketplace.affiliate_click_occurrences WHERE id=$1", [clickId]],
        ["DELETE FROM marketplace.affiliate_links WHERE id=$1", [linkId]],
        ["DELETE FROM marketplace.affiliate_published_terms WHERE id=$1", [termsId]],
        ["DELETE FROM marketplace.affiliate_agreements WHERE id=$1", [agreementId]],
        ["DELETE FROM booking.guest_bookings WHERE id=$1", [bookingId]],
        ["DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]],
        [
          "DELETE FROM identity.organization_resource_links WHERE organization_id IN ($1,$2)",
          [creatorOrganizationId, hotelOrganizationId],
        ],
        [
          "DELETE FROM identity.organizations WHERE id IN ($1,$2)",
          [creatorOrganizationId, hotelOrganizationId],
        ],
        ["DELETE FROM identity.users WHERE id=$1", [actorUserId]],
        ["INSERT INTO identity.users(id,email) VALUES($1,'vay-1516@example.test')", [actorUserId]],
        [
          `INSERT INTO identity.organizations(id,kind,name,slug) VALUES
             ($1,'creator_workspace','VAY 1516 creator','vay-1516-creator'),
             ($2,'hotel_group','VAY 1516 hotel','vay-1516-hotel')`,
          [creatorOrganizationId, hotelOrganizationId],
        ],
        [
          `INSERT INTO identity.organization_resource_links(
             id,organization_id,product,resource_type,resource_id,relationship
           ) VALUES($1,$2,'affiliate','affiliate',$3,'owner')`,
          [u("20"), creatorOrganizationId, affiliateId],
        ],
        [
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'vay-1516-property','VAY 1516 Property')",
          [propertyId],
        ],
        [
          `INSERT INTO booking.guest_bookings(
             id,property_id,public_reference,lifecycle_status,check_in,check_out,currency,created_at
           ) VALUES($1,$2,'VAY-1516-BOOKING','confirmed','2026-10-10','2026-10-11','EUR','2026-09-20T12:00:00Z')`,
          [bookingId, propertyId],
        ],
        [
          `INSERT INTO marketplace.affiliate_agreements(
             id,participation_id,program_id,offer_id,property_id,hotel_organization_id,
             creator_profile_id,creator_organization_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            agreementId,
            u("21"),
            u("22"),
            u("23"),
            propertyId,
            hotelOrganizationId,
            creatorProfileId,
            creatorOrganizationId,
          ],
        ],
        [
          `INSERT INTO marketplace.affiliate_published_terms(
             id,program_id,offer_id,property_id,organization_id,source_draft_id,disclosure,
             disclosure_hash,attribution_policy_version,evidence_references,actor_user_id,
             request_id,effective_at
           ) VALUES($1,$2,$3,$4,$5,$6,'{"terms":{"attributionWindowDays":30}}',$7,'v1','["terms"]',$8,'seed','2026-09-01Z')`,
          [
            termsId,
            u("22"),
            u("23"),
            propertyId,
            hotelOrganizationId,
            u("24"),
            "a".repeat(64),
            actorUserId,
          ],
        ],
        [
          `INSERT INTO marketplace.affiliate_links(
             id,agreement_id,activation_id,participation_id,program_id,property_id,public_token,
             contract_version,actor_user_id,actor_organization_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,'va_1516abcdefghijklmnopqr','marketplace-affiliate-link.v1',$7,$8,'seed')`,
          [
            linkId,
            agreementId,
            u("25"),
            u("21"),
            u("22"),
            propertyId,
            actorUserId,
            hotelOrganizationId,
          ],
        ],
        [
          `INSERT INTO marketplace.affiliate_click_occurrences(
             id,link_id,property_id,terms_id,reference_token,source,synthetic,clicked_at
           ) VALUES($1,$2,$3,$4,'vc_1516abcdefghijklmnopqr','instagram',false,'2026-09-19Z')`,
          [clickId, linkId, propertyId, termsId],
        ],
        [
          "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$2,false)",
          [contextId, propertyId],
        ],
        [
          "INSERT INTO booking.affiliate_click_admissions(context_id,property_id,click_id,history_position) VALUES($1,$2,$3,1)",
          [contextId, propertyId, clickId],
        ],
        [
          `INSERT INTO booking.affiliate_original_booking_bindings(
             booking_id,property_id,context_id,history_cutoff,original_public_reference,
             original_check_in,original_check_out,original_currency,synthetic
           ) VALUES($1,$2,$3,1,'VAY-1516-BOOKING','2026-10-10','2026-10-11','EUR',false)`,
          [bookingId, propertyId, contextId],
        ],
        [
          `INSERT INTO finance.affiliate_eligible_earning_revisions(
             earning_entry_id,contract_version,property_id,booking_id,stay_item_id,agreement_id,
             policy_version_id,source_revision,creator_profile_id,affiliate_id,
             beneficiary_organization_id,currency,currency_minor_unit,commission_minor,
             adjustment_minor,status
           ) VALUES
             ($1,'finance-affiliate-settlement-entry.v1',$2,$3,$4,$5,$6,1,$7,$8,$9,'EUR',2,1000,0,'eligible'),
             ($10,'finance-affiliate-settlement-entry.v1',$2,$3,$4,$5,$6,2,$7,'other-affiliate',$9,'EUR',2,1000,0,'eligible')`,
          [
            earningEntryId,
            propertyId,
            bookingId,
            u("36"),
            agreementId,
            u("37"),
            creatorProfileId,
            affiliateId,
            creatorOrganizationId,
            wrongAffiliateEarningId,
          ],
        ],
        [
          `INSERT INTO finance.payouts(id,owner_scope,organization_id,payout_status,amount,net_amount,currency,payout_metadata)
           VALUES ($1,'organization',$4,'paid',10,10,'EUR',$5),
                  ($2,'organization',$4,'paid',10,10,'EUR',$5),
                  ($3,'organization',$4,'paid',10,10,'EUR','{"affiliateId":"other-affiliate"}')`,
          [
            payoutId,
            unpaidPayoutId,
            wrongAffiliatePayoutId,
            creatorOrganizationId,
            JSON.stringify({ affiliateId }),
          ],
        ],
        [
          `INSERT INTO finance.affiliate_earning_allocations(
             earning_entry_id,entry_digest,entry_snapshot,creator_profile_id,affiliate_id,
             organization_id,property_id,booking_id,stay_item_id,agreement_id,policy_version_id,
             source_revision,currency,currency_minor_unit,commission_minor,adjustment_minor,
             status,recorded_at,allocated_at
           ) VALUES
             ($1,$2,'{"contractVersion":"finance-affiliate-settlement-entry.v1"}',$3,$4,$5,$6,$7,$8,$9,$10,1,'EUR',2,1000,0,'allocated',now(),now()),
             ($11,$2,'{"contractVersion":"finance-affiliate-settlement-entry.v1"}',$3,'other-affiliate',$5,$6,$7,$8,$9,$10,2,'EUR',2,1000,0,'allocated',now(),now())`,
          [
            earningEntryId,
            "b".repeat(64),
            creatorProfileId,
            affiliateId,
            creatorOrganizationId,
            propertyId,
            bookingId,
            u("36"),
            agreementId,
            u("37"),
            wrongAffiliateEarningId,
          ],
        ],
        [
          `INSERT INTO finance.affiliate_earning_allocation_items(earning_entry_id,payout_id,applied_minor)
           VALUES($1,$2,500),($1,$3,500),($4,$5,1000)`,
          [
            earningEntryId,
            payoutId,
            unpaidPayoutId,
            wrongAffiliateEarningId,
            wrongAffiliatePayoutId,
          ],
        ],
        [
          `INSERT INTO finance.affiliate_payout_payment_evidence(
             id,organization_id,affiliate_id,recorded_by_organization_id,recorded_by_user_id,
             idempotency_key_id,command_id,request_fingerprint_hash,payment_method,
             external_reference,evidence_reference,amount,currency,payout_count,paid_at
           ) VALUES($1,$2,$3,$4,$5,$6,'command-1516',$7,'bank_transfer',
                    'transfer-1516','evidence-1516',10,'EUR',1,now())`,
          [
            paymentEvidenceId,
            creatorOrganizationId,
            affiliateId,
            hotelOrganizationId,
            actorUserId,
            u("38"),
            "c".repeat(64),
          ],
        ],
        [
          `INSERT INTO finance.affiliate_payout_payment_evidence_items(
             evidence_id,organization_id,payout_id,amount,currency
           ) VALUES($1,$2,$3,10,'EUR')`,
          [paymentEvidenceId, creatorOrganizationId, payoutId],
        ],
      ];
      for (const [text, values] of statements) await client.query(text, values);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

function assertSafeTestDatabase(connectionString: string) {
  const parsed = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "postgres"].includes(parsed.hostname)) {
    throw new Error(
      "Refusing to run affiliate discrepancy integration test outside local PostgreSQL",
    );
  }
}
