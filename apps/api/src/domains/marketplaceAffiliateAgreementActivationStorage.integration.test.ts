import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { assentFixture, disclosureHash } from "./affiliateAssentTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import { readMarketplaceAffiliateAgreementLifecycle } from "./marketplaceAffiliateAgreementLifecycle.js";

const migration = new URL(
  "../../../../packages/backend-migration/migrations/0214_marketplace_affiliate_agreement_activation.sql",
  import.meta.url,
);
const lifecycleMigration = new URL(
  "../../../../packages/backend-migration/migrations/0326_marketplace_affiliate_agreement_lifecycle.sql",
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
    await pool().query(await readFile(lifecycleMigration, "utf8"));
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

  async function lifecycle() {
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const result = await readMarketplaceAffiliateAgreementLifecycle(client, agreementId);
      await client.query("COMMIT");
      return result;
    } finally {
      client.release();
    }
  }

  async function append(revision: number, action: string, side: string, effectiveAt?: string) {
    return pool().query(
      `INSERT INTO marketplace.affiliate_agreement_lifecycle_events
       (id,agreement_id,revision,action,actor_side,actor_user_id,
        actor_organization_id,reason,request_id,effective_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'fixture','fixture',COALESCE($8::timestamptz,clock_timestamp()))
       RETURNING effective_at`,
      [
        randomUUID(),
        agreementId,
        revision,
        action,
        side,
        id(side === "hotel" ? 1 : 81),
        id(side === "hotel" ? 4 : 80),
        effectiveAt ?? null,
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

  it("derives active, paused and ended from independent agreement history", async () => {
    expect(await lifecycle()).toEqual({ status: "unavailable" });
    await agreement();
    await activate();
    expect(await lifecycle()).toEqual({ status: "active", revision: 0 });
    await append(1, "pause", "hotel");
    await append(2, "pause", "creator");
    expect(await lifecycle()).toEqual({ status: "paused", revision: 2 });
    await append(3, "resume", "hotel");
    expect(await lifecycle()).toEqual({ status: "paused", revision: 3 });
    await append(4, "resume", "creator");
    expect(await lifecycle()).toEqual({ status: "active", revision: 4 });
    await append(5, "end", "hotel");
    expect(await lifecycle()).toEqual({ status: "ended", revision: 5 });
  });

  it("fails closed on invalid history and protects event evidence", async () => {
    await agreement();
    await activate();
    await append(2, "pause", "hotel");
    expect(await lifecycle()).toEqual({ status: "invalid_history" });
    await append(1, "pause", "hotel");
    await expect(append(1, "pause", "hotel")).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool().query("UPDATE marketplace.affiliate_agreement_lifecycle_events SET reason='changed'"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool().query("DELETE FROM marketplace.affiliate_agreement_lifecycle_events"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool().query("TRUNCATE marketplace.affiliate_agreement_lifecycle_events"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    { events: [[1, "resume", "hotel"]] },
    {
      events: [
        [1, "pause", "hotel"],
        [2, "pause", "hotel"],
      ],
    },
    {
      events: [
        [1, "pause", "creator"],
        [2, "resume", "hotel"],
      ],
    },
    {
      events: [
        [1, "end", "creator"],
        [2, "pause", "hotel"],
      ],
    },
  ])("rejects invalid lifecycle transitions in a fresh history: $events", async ({ events }) => {
    await agreement();
    await activate();
    for (const [revision, action, side] of events)
      await append(revision as number, action as string, side as string);
    expect(await lifecycle()).toEqual({ status: "invalid_history" });
  });

  it("ignores caller-supplied lifecycle timestamps", async () => {
    await agreement();
    await activate();
    const before = (await pool().query("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
    const inserted = await append(1, "end", "hotel", "2099-01-01T00:00:00Z");
    const stamped = inserted.rows[0].effective_at.getTime();
    const after = (await pool().query("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
    expect(await lifecycle()).toEqual({ status: "ended", revision: 1 });
  });

  it("stamps a pause after an in-flight active read releases its lock", async () => {
    await agreement();
    await activate();
    const reader = await pool().connect();
    const writer = await pool().connect();
    let pending: Promise<Date> | undefined;
    try {
      await reader.query("BEGIN");
      expect(await readMarketplaceAffiliateAgreementLifecycle(reader, agreementId)).toEqual({
        status: "active",
        revision: 0,
      });
      const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = writer
        .query(
          `INSERT INTO marketplace.affiliate_agreement_lifecycle_events
         (id,agreement_id,revision,action,actor_side,actor_user_id,
          actor_organization_id,reason,request_id)
         VALUES ($1,$2,1,'pause','hotel',$3,$4,'fixture','fixture')
         RETURNING effective_at`,
          [randomUUID(), agreementId, id(1), id(4)],
        )
        .then((result) => result.rows[0].effective_at as Date);
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const activity = await pool().query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
          [writerPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const beforeRelease = (await reader.query("SELECT clock_timestamp() AS now")).rows[0].now;
      await reader.query("COMMIT");
      expect((await pending).getTime()).toBeGreaterThanOrEqual(beforeRelease.getTime());
      expect(await lifecycle()).toEqual({ status: "paused", revision: 1 });
    } finally {
      await reader.query("ROLLBACK");
      if (pending) await pending.catch(() => undefined);
      reader.release();
      writer.release();
    }
  });
});
