import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { assentCommandFixture, assentInput } from "./affiliateAssentCommandTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import {
  activateMarketplaceAffiliateAgreement,
  type AffiliateAgreementActivationReadiness,
} from "./marketplaceAffiliateAgreementActivation.js";
import { recordAffiliateAssent } from "./marketplaceAffiliateAssentCommand.js";

const migration = new URL(
  "../../../../packages/backend-migration/migrations/0214_marketplace_affiliate_agreement_activation.sql",
  import.meta.url,
);

describe.skipIf(!databaseUrl)("affiliate agreement activation command", () => {
  const fixture = assentCommandFixture();
  const pool = () => fixture.pool();

  beforeEach(async () => {
    await pool().query(await readFile(migration, "utf8"));
  });

  async function matchAssent() {
    expect(await recordAffiliateAssent(pool(), assentInput())).toMatchObject({
      ok: true,
      state: "pending",
    });
    expect(
      await recordAffiliateAssent(pool(), { ...assentInput(false), expectedRevision: 1 }),
    ).toMatchObject({ ok: true, state: "matched" });
  }

  function input(hotel = true) {
    return {
      context: assentInput(hotel).context,
      propertyId: id(3),
      programId: id(50),
      creatorProfileId: id(82),
      attemptId: id(100),
      termsId: id(51),
      expectedRevision: 0 as const,
      idempotencyKey: hotel ? "activate-hotel" : "activate-creator",
    };
  }

  const ready: AffiliateAgreementActivationReadiness = async (_client, scope) => ({
    status: "ready",
    scope,
    enrollmentOpen: true,
    evidenceReferences: ["booking:destination:ready", "finance:policy:approved"],
  });

  async function counts() {
    const result = [];
    for (const table of ["affiliate_agreements", "affiliate_agreement_activations"])
      result.push(
        Number((await pool().query(`SELECT count(*) FROM marketplace.${table}`)).rows[0].count),
      );
    return result;
  }

  it.each([true, false])(
    "activates matched assent for an authorized side (hotel: %s)",
    async (hotel) => {
      await matchAssent();
      const result = await activateMarketplaceAffiliateAgreement(pool(), input(hotel), ready);
      expect(result).toMatchObject({ ok: true, replayed: false });
      if (!result.ok) throw new Error("Expected activation");
      expect(new Date(result.effectiveAt).getTime()).toBeGreaterThan(0);
      expect(await activateMarketplaceAffiliateAgreement(pool(), input(hotel), ready)).toEqual({
        ...result,
        replayed: true,
      });
      expect(await counts()).toEqual([1, 1]);
      expect(
        (
          await pool().query(
            `SELECT g.participation_id,g.offer_id,g.property_id,g.creator_profile_id,
            a.attempt_id,a.terms_id,a.actor_organization_id,a.readiness_evidence
          FROM marketplace.affiliate_agreements g
          JOIN marketplace.affiliate_agreement_activations a ON a.agreement_id=g.id`,
          )
        ).rows[0],
      ).toMatchObject({
        offer_id: id(2),
        property_id: id(3),
        creator_profile_id: id(82),
        attempt_id: id(100),
        terms_id: id(51),
        actor_organization_id: id(hotel ? 4 : 80),
        readiness_evidence: ["booking:destination:ready", "finance:policy:approved"],
      });
    },
  );

  it("fails closed before readiness exists and leaves no partial agreement", async () => {
    await matchAssent();
    expect(await activateMarketplaceAffiliateAgreement(pool(), input())).toEqual({
      ok: false,
      code: "activation_blocked",
      reasons: ["activation_readiness_adapter_missing"],
    });
    expect(await counts()).toEqual([0, 0]);
  });

  it("requires exact matched assent and rejects a substituted attempt or terms", async () => {
    await recordAffiliateAssent(pool(), assentInput());
    expect(await activateMarketplaceAffiliateAgreement(pool(), input(), ready)).toEqual({
      ok: false,
      code: "assent_not_matched",
    });
    for (const change of [{ attemptId: id(101) }, { termsId: id(52) }])
      expect(
        await activateMarketplaceAffiliateAgreement(pool(), { ...input(), ...change }, ready),
      ).toMatchObject({ ok: false, code: "scope_unavailable" });
    expect(await counts()).toEqual([0, 0]);
  });

  it("serializes retries and refuses a second active agreement", async () => {
    await matchAssent();
    const duplicate = await Promise.all([
      activateMarketplaceAffiliateAgreement(pool(), input(), ready),
      activateMarketplaceAffiliateAgreement(pool(), input(), ready),
    ]);
    expect(duplicate.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(duplicate.filter((result) => result.ok && result.replayed)).toHaveLength(1);
    expect(
      await activateMarketplaceAffiliateAgreement(
        pool(),
        { ...input(), idempotencyKey: "competing" },
        ready,
      ),
    ).toEqual({ ok: false, code: "agreement_already_active" });
    expect(await counts()).toEqual([1, 1]);
  });

  it("authorizes before replay and conflicts when an authorized actor reuses the key", async () => {
    await matchAssent();
    await activateMarketplaceAffiliateAgreement(pool(), input(), ready);
    const revoked = input();
    revoked.context.linkedResources = [];
    await expect(activateMarketplaceAffiliateAgreement(pool(), revoked, ready)).rejects.toThrow();

    await pool().query("INSERT INTO identity.users VALUES ($1)", [id(9)]);
    const changedActor = input();
    changedActor.context.actor.internalUserId = id(9);
    expect(await activateMarketplaceAffiliateAgreement(pool(), changedActor, ready)).toEqual({
      ok: false,
      code: "idempotency_conflict",
    });
    expect(await counts()).toEqual([1, 1]);
  });

  it("rechecks persisted scope and active offer before replay", async () => {
    await matchAssent();
    await activateMarketplaceAffiliateAgreement(pool(), input(), ready);
    await pool().query(
      "UPDATE identity.organization_resource_links SET status='inactive' WHERE id=$1",
      [id(90)],
    );
    expect(await activateMarketplaceAffiliateAgreement(pool(), input(), ready)).toEqual({
      ok: false,
      code: "scope_unavailable",
    });
    await pool().query(
      "UPDATE identity.organization_resource_links SET status='active' WHERE id=$1",
      [id(90)],
    );
    await pool().query(
      "UPDATE marketplace.marketplace_offers SET offer_status='suspended' WHERE id=$1",
      [id(2)],
    );
    expect(await activateMarketplaceAffiliateAgreement(pool(), input(), ready)).toEqual({
      ok: false,
      code: "scope_unavailable",
    });
    expect(await counts()).toEqual([1, 1]);
  });

  it("rejects malformed or mismatched readiness proof and rolls back receipt failures", async () => {
    await matchAssent();
    for (const providedScope of [{}, { propertyId: id(3) }, { propertyId: id(6) }]) {
      const mismatched: AffiliateAgreementActivationReadiness = async () =>
        ({
          status: "ready",
          scope: providedScope,
          enrollmentOpen: true,
          evidenceReferences: ["synthetic"],
        }) as Awaited<ReturnType<AffiliateAgreementActivationReadiness>>;
      await expect(
        activateMarketplaceAffiliateAgreement(pool(), input(), mismatched),
      ).rejects.toThrow("Invalid affiliate activation readiness proof");
    }
    const unknownStatus: AffiliateAgreementActivationReadiness = async (_client, scope) =>
      ({
        status: "unknown",
        scope,
        enrollmentOpen: true,
        evidenceReferences: ["synthetic"],
      }) as unknown as Awaited<ReturnType<AffiliateAgreementActivationReadiness>>;
    await expect(
      activateMarketplaceAffiliateAgreement(pool(), input(), unknownStatus),
    ).rejects.toThrow("Invalid affiliate activation readiness proof");
    expect(await counts()).toEqual([0, 0]);

    await pool().query(
      `CREATE FUNCTION platform.fail_activation_test() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'synthetic activation receipt failure'; END $$;
       CREATE TRIGGER fail_activation_test BEFORE INSERT ON platform.idempotency_keys
       FOR EACH ROW WHEN (NEW.operation = 'marketplace.affiliate_agreement.activate')
       EXECUTE FUNCTION platform.fail_activation_test()`,
    );
    await expect(activateMarketplaceAffiliateAgreement(pool(), input(), ready)).rejects.toThrow(
      "synthetic activation receipt failure",
    );
    expect(await counts()).toEqual([0, 0]);
  });

  it.each([{ expectedRevision: 1 }, { idempotencyKey: " " }, { attemptId: "invalid" }])(
    "rejects malformed input %#",
    async (change) => {
      expect(
        await activateMarketplaceAffiliateAgreement(
          pool(),
          { ...input(), ...change } as Parameters<typeof activateMarketplaceAffiliateAgreement>[1],
          ready,
        ),
      ).toEqual({ ok: false, code: "invalid_request" });
    },
  );
});
