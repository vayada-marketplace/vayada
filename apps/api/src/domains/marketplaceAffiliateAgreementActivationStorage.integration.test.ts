import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { assentFixture, disclosureHash } from "./affiliateAssentTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";

const migration = new URL(
  "../../../../packages/backend-migration/migrations/0214_marketplace_affiliate_agreement_activation.sql",
  import.meta.url,
);

describe.skipIf(!databaseUrl)("affiliate agreement activation storage", () => {
  const fixture = assentFixture();
  const pool = () => fixture.pool();
  const participationId = id(83);
  const attemptId = id(84);
  const hotelApprovalId = id(85);
  const creatorAcceptanceId = id(86);
  const agreementId = id(87);

  beforeEach(async () => {
    await pool().query(await readFile(migration, "utf8"));
    await pool().query("INSERT INTO marketplace.affiliate_participations VALUES ($1,$2,$3,$4)", [
      participationId,
      id(50),
      id(82),
      id(80),
    ]);
    await pool().query(
      `INSERT INTO marketplace.affiliate_participation_attempts
      (id,participation_id,program_id,terms_id,attempt_number,origin,actor_user_id,actor_organization_id,request_id)
      VALUES ($1,$2,$3,$4,1,'application',$5,$6,'fixture')`,
      [attemptId, participationId, id(50), id(51), id(81), id(80)],
    );
    for (const [decisionId, decision, revision, actorId, organizationId] of [
      [hotelApprovalId, "hotel_approval", 1, id(1), id(4)],
      [creatorAcceptanceId, "creator_acceptance", 2, id(81), id(80)],
    ] as const)
      await pool().query(
        `INSERT INTO marketplace.affiliate_assent_decisions
        (id,attempt_id,terms_id,decision,revision,disclosure_hash,actor_user_id,actor_organization_id,request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'fixture')`,
        [
          decisionId,
          attemptId,
          id(51),
          decision,
          revision,
          disclosureHash,
          actorId,
          organizationId,
        ],
      );
  });

  async function agreement(
    agreement = agreementId,
    participation = participationId,
    creator = id(82),
  ) {
    return pool().query(
      `INSERT INTO marketplace.affiliate_agreements
      (id,participation_id,program_id,offer_id,property_id,hotel_organization_id,creator_profile_id,creator_organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [agreement, participation, id(50), id(2), id(3), id(4), creator, id(80)],
    );
  }

  async function activate(overrides: Record<string, unknown> = {}) {
    const values = {
      activationId: id(88),
      agreementId,
      participationId,
      programId: id(50),
      attemptId,
      termsId: id(51),
      hotelApprovalId,
      hotelDecision: "hotel_approval",
      creatorAcceptanceId,
      creatorDecision: "creator_acceptance",
      ...overrides,
    };
    return pool().query(
      `INSERT INTO marketplace.affiliate_agreement_activations
      (id,agreement_id,participation_id,program_id,attempt_id,terms_id,
       hotel_approval_id,hotel_decision,creator_acceptance_id,creator_decision,
       contract_version,readiness_evidence,actor_user_id,actor_organization_id,request_id,effective_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       'marketplace-affiliate-agreement-activation.v1','["synthetic-readiness"]',$11,$12,'fixture',now())`,
      [
        values.activationId,
        values.agreementId,
        values.participationId,
        values.programId,
        values.attemptId,
        values.termsId,
        values.hotelApprovalId,
        values.hotelDecision,
        values.creatorAcceptanceId,
        values.creatorDecision,
        id(1),
        id(4),
      ],
    );
  }

  it("pins one stable agreement to exact matching assent and readiness evidence", async () => {
    await agreement();
    await activate();
    expect(
      (
        await pool().query(
          `SELECT a.participation_id,a.property_id,a.creator_profile_id,
            x.attempt_id,x.terms_id,x.hotel_approval_id,x.creator_acceptance_id,x.readiness_evidence
          FROM marketplace.affiliate_agreements a
          JOIN marketplace.affiliate_agreement_activations x ON x.agreement_id=a.id`,
        )
      ).rows,
    ).toEqual([
      {
        participation_id: participationId,
        property_id: id(3),
        creator_profile_id: id(82),
        attempt_id: attemptId,
        terms_id: id(51),
        hotel_approval_id: hotelApprovalId,
        creator_acceptance_id: creatorAcceptanceId,
        readiness_evidence: ["synthetic-readiness"],
      },
    ]);
  });

  it("rejects another creator, mismatched assent sides and foreign attempts", async () => {
    await expect(agreement(agreementId, participationId, id(89))).rejects.toMatchObject({
      code: "23503",
    });
    await agreement();
    await expect(activate({ hotelApprovalId: creatorAcceptanceId })).rejects.toMatchObject({
      code: "23503",
    });
    await expect(activate({ creatorAcceptanceId: hotelApprovalId })).rejects.toMatchObject({
      code: "23503",
    });
    await expect(activate({ attemptId: randomUUID() })).rejects.toMatchObject({ code: "23503" });
  });

  it("activates one agreement per matched attempt without blocking a future agreement identity", async () => {
    await agreement();
    const laterAgreementId = randomUUID();
    await agreement(laterAgreementId);
    await activate();
    await expect(
      activate({ activationId: randomUUID(), agreementId: laterAgreementId }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_agreements")).rows[0],
    ).toEqual({ count: "2" });
  });

  it("preserves agreement identity and activation evidence against mutation", async () => {
    await agreement();
    await activate();
    for (const table of ["affiliate_agreements", "affiliate_agreement_activations"]) {
      const before = (await pool().query(`SELECT * FROM marketplace.${table}`)).rows;
      for (const sql of [
        `UPDATE marketplace.${table} SET id=id`,
        `DELETE FROM marketplace.${table}`,
        `TRUNCATE marketplace.${table} CASCADE`,
      ])
        await expect(pool().query(sql)).rejects.toMatchObject({ code: "23514" });
      expect((await pool().query(`SELECT * FROM marketplace.${table}`)).rows).toEqual(before);
    }
  });
});
