import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";

import { assentFixture, disclosureHash } from "./affiliateAssentTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";

const agreementMigration = new URL(
  "../../../../packages/backend-migration/migrations/0214_marketplace_affiliate_agreement_activation.sql",
  import.meta.url,
);
const linkIndexMigration = new URL(
  "../../../../packages/backend-migration/migrations/0324_marketplace_affiliate_links.sql",
  import.meta.url,
);
const linkMigration = new URL(
  "../../../../packages/backend-migration/migrations/0325_marketplace_affiliate_links.sql",
  import.meta.url,
);

describe.skipIf(!databaseUrl)("affiliate link storage", () => {
  const fixture = assentFixture();
  const pool = () => fixture.pool();
  const participationId = id(83);
  const attemptId = id(84);
  const agreementId = id(87);
  const activationId = id(88);
  const linkId = id(89);
  const token = "va_0123456789abcdefghij-_";

  beforeEach(async () => {
    await pool().query(await readFile(agreementMigration, "utf8"));
    for (const statement of (await readFile(linkIndexMigration, "utf8")).split(
      "-- vayada:next-statement",
    ))
      await pool().query(statement);
    await pool().query(await readFile(linkMigration, "utf8"));
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
      [id(85), "hotel_approval", 1, id(1), id(4)],
      [id(86), "creator_acceptance", 2, id(81), id(80)],
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
    await pool().query(
      `INSERT INTO marketplace.affiliate_agreements
      (id,participation_id,program_id,offer_id,property_id,hotel_organization_id,creator_profile_id,creator_organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [agreementId, participationId, id(50), id(2), id(3), id(4), id(82), id(80)],
    );
    await pool().query(
      `INSERT INTO marketplace.affiliate_agreement_activations
      (id,agreement_id,participation_id,program_id,attempt_id,terms_id,
       hotel_approval_id,hotel_decision,creator_acceptance_id,creator_decision,
       contract_version,readiness_evidence,actor_user_id,actor_organization_id,request_id,effective_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'hotel_approval',$8,'creator_acceptance',
       'marketplace-affiliate-agreement-activation.v1','["synthetic-readiness"]',$9,$10,'fixture',now())`,
      [
        activationId,
        agreementId,
        participationId,
        id(50),
        attemptId,
        id(51),
        id(85),
        id(86),
        id(1),
        id(4),
      ],
    );
  });

  const insert = (overrides: Record<string, unknown> = {}) => {
    const value = {
      linkId,
      agreementId,
      activationId,
      participationId,
      programId: id(50),
      propertyId: id(3),
      token,
      ...overrides,
    };
    return pool().query(
      `INSERT INTO marketplace.affiliate_links
      (id,agreement_id,activation_id,participation_id,program_id,property_id,public_token,
       contract_version,actor_user_id,actor_organization_id,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'marketplace-affiliate-link.v1',$8,$9,'fixture')`,
      [
        value.linkId,
        value.agreementId,
        value.activationId,
        value.participationId,
        value.programId,
        value.propertyId,
        value.token,
        id(1),
        id(4),
      ],
    );
  };

  it("pins one canonical token to the exact activated agreement and property", async () => {
    await insert();
    expect(
      (
        await pool().query(
          `SELECT id,agreement_id,activation_id,participation_id,program_id,property_id,
            public_token,contract_version
          FROM marketplace.affiliate_links`,
        )
      ).rows,
    ).toEqual([
      {
        id: linkId,
        agreement_id: agreementId,
        activation_id: activationId,
        participation_id: participationId,
        program_id: id(50),
        property_id: id(3),
        public_token: token,
        contract_version: "marketplace-affiliate-link.v1",
      },
    ]);
  });

  it("rejects substituted agreement scope and non-activated agreement references", async () => {
    for (const override of [
      { propertyId: id(6) },
      { programId: id(60) },
      { participationId: id(90) },
      { activationId: id(91) },
      { agreementId: id(92) },
    ])
      await expect(insert(override)).rejects.toMatchObject({ code: "23503" });
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_links")).rows[0],
    ).toEqual({ count: "0" });
  });

  it("allows only one canonical link per agreement and activation", async () => {
    await insert();
    await expect(
      insert({ linkId: id(93), token: "va_abcdefghijklmnopqrstuv" }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_links")).rows[0],
    ).toEqual({ count: "1" });
  });

  it.each(["", "VA_0123456789abcdefghij-_", "va_short", "va_0123456789abcdefghij+/"])(
    "rejects malformed public token %s",
    async (publicToken) => {
      await expect(insert({ token: publicToken })).rejects.toMatchObject({ code: "23514" });
    },
  );

  it("preserves canonical link ownership against mutation", async () => {
    await insert();
    const before = (await pool().query("SELECT * FROM marketplace.affiliate_links")).rows;
    for (const sql of [
      "UPDATE marketplace.affiliate_links SET public_token=public_token",
      "DELETE FROM marketplace.affiliate_links",
      "TRUNCATE marketplace.affiliate_links CASCADE",
    ])
      await expect(pool().query(sql)).rejects.toMatchObject({ code: "23514" });
    expect((await pool().query("SELECT * FROM marketplace.affiliate_links")).rows).toEqual(before);
  });
});
