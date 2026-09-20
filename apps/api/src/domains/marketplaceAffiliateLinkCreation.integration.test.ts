import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { assentCommandFixture, assentInput } from "./affiliateAssentCommandTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import {
  activateMarketplaceAffiliateAgreement,
  type AffiliateAgreementActivationReadiness,
} from "./marketplaceAffiliateAgreementActivation.js";
import { recordAffiliateAssent } from "./marketplaceAffiliateAssentCommand.js";
import {
  createMarketplaceAffiliateLink,
  type AffiliateLinkCreationReadiness,
} from "./marketplaceAffiliateLinkCreation.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);

describe.skipIf(!databaseUrl)("affiliate link creation", () => {
  const fixture = assentCommandFixture();
  const pool = () => fixture.pool();
  let agreementId: string;

  const ready: AffiliateLinkCreationReadiness = async (_client, scope) => ({
    status: "ready",
    scope,
  });

  const input = () => ({
    context: assentInput(false).context,
    agreementId,
    idempotencyKey: "create-link",
  });

  beforeEach(async () => {
    await pool().query(
      await readFile(
        new URL("0214_marketplace_affiliate_agreement_activation.sql", migrations),
        "utf8",
      ),
    );
    expect(await recordAffiliateAssent(pool(), assentInput())).toMatchObject({ ok: true });
    expect(
      await recordAffiliateAssent(pool(), { ...assentInput(false), expectedRevision: 1 }),
    ).toMatchObject({ ok: true, state: "matched" });
    const activationReadiness: AffiliateAgreementActivationReadiness = async (_client, scope) => ({
      status: "ready",
      scope,
      enrollmentOpen: true,
      evidenceReferences: ["synthetic-readiness"],
    });
    const activation = await activateMarketplaceAffiliateAgreement(
      pool(),
      {
        context: assentInput(false).context,
        propertyId: id(3),
        programId: id(50),
        creatorProfileId: id(82),
        attemptId: id(100),
        termsId: id(51),
        expectedRevision: 0,
        idempotencyKey: "activation-before-link",
      },
      activationReadiness,
    );
    if (!activation.ok) throw new Error(`Synthetic activation failed: ${activation.code}`);
    agreementId = activation.agreementId;
    for (const statement of (
      await readFile(new URL("0324_marketplace_affiliate_links.sql", migrations), "utf8")
    ).split("-- vayada:next-statement"))
      await pool().query(statement);
    await pool().query(
      await readFile(new URL("0325_marketplace_affiliate_links.sql", migrations), "utf8"),
    );
  });

  it("creates one stable creator-owned link with a default share path", async () => {
    const created = await createMarketplaceAffiliateLink(pool(), input(), ready);
    expect(created).toMatchObject({
      ok: true,
      contractVersion: "marketplace-affiliate-link.v1",
      agreementId,
      propertyId: id(3),
      replayed: false,
    });
    if (!created.ok) throw new Error("Expected link");
    expect(created.publicToken).toMatch(/^va_[A-Za-z0-9_-]{22}$/);
    expect(created.path).toBe(`/r/${created.publicToken}`);
    expect(await createMarketplaceAffiliateLink(pool(), input())).toEqual({
      ...created,
      replayed: true,
    });
    expect(
      await createMarketplaceAffiliateLink(pool(), { ...input(), idempotencyKey: "another-retry" }),
    ).toEqual({ ...created, replayed: true });
    const revoked = input();
    revoked.context.linkedResources = [];
    await expect(createMarketplaceAffiliateLink(pool(), revoked)).rejects.toThrow();
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_links")).rows[0].count,
    ).toBe("1");
  });

  it("serializes concurrent requests for the same agreement", async () => {
    const results = await Promise.all([
      createMarketplaceAffiliateLink(pool(), input(), ready),
      createMarketplaceAffiliateLink(pool(), input(), ready),
    ]);
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(1);
    expect(results[0]).toMatchObject({ linkId: (results[1] as { linkId: string }).linkId });
  });

  it("fails closed when readiness is unavailable and creates no partial link", async () => {
    expect(await createMarketplaceAffiliateLink(pool(), input())).toEqual({
      ok: false,
      code: "link_creation_blocked",
      reasons: ["link_creation_readiness_adapter_missing"],
    });
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_links")).rows[0].count,
    ).toBe("0");
  });

  it("rejects another actor, organization, and revoked creator scope", async () => {
    const other = input();
    other.context.actor.internalUserId = id(9);
    expect(await createMarketplaceAffiliateLink(pool(), other, ready)).toEqual({
      ok: false,
      code: "scope_unavailable",
    });
    const hotel = { ...input(), context: assentInput().context };
    expect(await createMarketplaceAffiliateLink(pool(), hotel, ready)).toEqual({
      ok: false,
      code: "scope_unavailable",
    });
    const revoked = input();
    revoked.context.linkedResources = [];
    await expect(createMarketplaceAffiliateLink(pool(), revoked, ready)).rejects.toThrow();
    await pool().query(
      "UPDATE identity.organization_resource_links SET status='inactive' WHERE id=$1",
      [id(91)],
    );
    expect(await createMarketplaceAffiliateLink(pool(), input(), ready)).toEqual({
      ok: false,
      code: "scope_unavailable",
    });
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_links")).rows[0].count,
    ).toBe("0");
  });

  it("rejects an incorrect readiness scope and rolls back a failed receipt", async () => {
    const mismatched: AffiliateLinkCreationReadiness = async (_client, scope) => ({
      status: "ready",
      scope: { ...scope, propertyId: id(6) },
    });
    await expect(createMarketplaceAffiliateLink(pool(), input(), mismatched)).rejects.toThrow(
      "Invalid affiliate link readiness proof",
    );
    await pool().query(
      `CREATE FUNCTION platform.fail_link_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'synthetic link receipt failure'; END $$;
       CREATE TRIGGER fail_link_receipt_test BEFORE INSERT ON platform.idempotency_keys
       FOR EACH ROW WHEN (NEW.operation = 'marketplace.affiliate_link.create')
       EXECUTE FUNCTION platform.fail_link_receipt_test()`,
    );
    await expect(createMarketplaceAffiliateLink(pool(), input(), ready)).rejects.toThrow(
      "synthetic link receipt failure",
    );
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_links")).rows[0].count,
    ).toBe("0");
  });

  it.each([{ agreementId: "invalid" }, { idempotencyKey: " " }])(
    "rejects invalid input without writing: %j",
    async (change) => {
      expect(
        await createMarketplaceAffiliateLink(pool(), { ...input(), ...change }, ready),
      ).toEqual({
        ok: false,
        code: "invalid_request",
      });
      expect(
        (await pool().query("SELECT count(*) FROM marketplace.affiliate_links")).rows[0].count,
      ).toBe("0");
    },
  );
});
