import { readFile } from "node:fs/promises";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { assentCommandFixture, assentInput } from "./affiliateAssentCommandTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import {
  activateMarketplaceAffiliateAgreement,
  type AffiliateAgreementActivationReadiness,
} from "./marketplaceAffiliateAgreementActivation.js";
import { recordAffiliateAssent } from "./marketplaceAffiliateAssentCommand.js";
import { changeMarketplaceAffiliateAgreementLifecycle } from "./marketplaceAffiliateAgreementLifecycleCommand.js";
import {
  createMarketplaceAffiliateLink,
  type AffiliateLinkCreationReadiness,
} from "./marketplaceAffiliateLinkCreation.js";
import { readMarketplaceAffiliateLinkEligibility } from "./marketplaceAffiliateLinkEligibility.js";
import {
  affiliateTrafficSource,
  recordSyntheticMarketplaceAffiliateClick,
} from "./marketplaceAffiliateClickOccurrence.js";
import {
  admitSyntheticAffiliateClick,
  createSyntheticAffiliateClickContext,
} from "./bookingAffiliateClickAdmission.js";

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
    await pool().query(
      await readFile(
        new URL("0326_marketplace_affiliate_agreement_lifecycle.sql", migrations),
        "utf8",
      ),
    );
    await pool().query(
      await readFile(
        new URL("0403_marketplace_affiliate_click_occurrences.sql", migrations),
        "utf8",
      ),
    );
    await pool().query("DROP SCHEMA IF EXISTS booking CASCADE; CREATE SCHEMA booking");
    await pool().query(
      await readFile(new URL("0328_booking_affiliate_click_admissions.sql", migrations), "utf8"),
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

  it("records separate synthetic visits without trusting referrer for ownership", async () => {
    const link = await createMarketplaceAffiliateLink(pool(), input(), ready);
    if (!link.ok) throw new Error("Expected link");
    const first = await recordSyntheticMarketplaceAffiliateClick(
      pool(),
      link.publicToken,
      "https://www.instagram.com/p/example",
    );
    const second = await recordSyntheticMarketplaceAffiliateClick(
      pool(),
      link.publicToken,
      "https://notinstagram.com/p/example",
    );
    expect(first).toMatchObject({ status: "recorded", source: "instagram" });
    expect(second).toMatchObject({ status: "recorded", source: "unknown" });
    if (first.status !== "recorded" || second.status !== "recorded")
      throw new Error("Missing click");
    expect(second.clickId).not.toBe(first.clickId);
    expect(second.referenceToken).not.toBe(first.referenceToken);
    await expect(
      pool().query("UPDATE marketplace.affiliate_click_occurrences SET source='x' WHERE id=$1", [
        first.clickId,
      ]),
    ).rejects.toThrow();
    expect(
      (
        await pool().query(
          `SELECT c.link_id,l.agreement_id,g.creator_profile_id,c.terms_id,c.property_id,
                  c.synthetic,c.source
           FROM marketplace.affiliate_click_occurrences c
           JOIN marketplace.affiliate_links l ON l.id=c.link_id
           JOIN marketplace.affiliate_agreements g ON g.id=l.agreement_id
           ORDER BY c.source`,
        )
      ).rows,
    ).toEqual([
      {
        link_id: link.linkId,
        agreement_id: agreementId,
        creator_profile_id: id(82),
        terms_id: id(51),
        property_id: id(3),
        synthetic: true,
        source: "instagram",
      },
      {
        link_id: link.linkId,
        agreement_id: agreementId,
        creator_profile_id: id(82),
        terms_id: id(51),
        property_id: id(3),
        synthetic: true,
        source: "unknown",
      },
    ]);
    expect(affiliateTrafficSource("https://instagram.com.evil.example/")).toBe("unknown");
  });

  it("blocks synthetic capture after a hotel pauses the agreement", async () => {
    const link = await createMarketplaceAffiliateLink(pool(), input(), ready);
    if (!link.ok) throw new Error("Expected link");
    expect(await recordSyntheticMarketplaceAffiliateClick(pool(), link.publicToken)).toMatchObject({
      status: "recorded",
      source: "unknown",
    });
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        context: assentInput().context,
        agreementId,
        action: "pause",
        reason: "Hotel pause",
        expectedRevision: 0,
        idempotencyKey: "pause-before-next-click",
      }),
    ).toMatchObject({ ok: true });
    expect(await recordSyntheticMarketplaceAffiliateClick(pool(), link.publicToken)).toEqual({
      status: "unavailable",
    });
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_click_occurrences")).rows[0]
        .count,
    ).toBe("1");
  });

  it("admits trusted clicks once in destination order and rejects another context", async () => {
    const link = await createMarketplaceAffiliateLink(pool(), input(), ready);
    if (!link.ok) throw new Error("Expected link");
    const first = await recordSyntheticMarketplaceAffiliateClick(pool(), link.publicToken);
    const second = await recordSyntheticMarketplaceAffiliateClick(pool(), link.publicToken);
    if (first.status !== "recorded" || second.status !== "recorded")
      throw new Error("Missing click");
    const contextId = await createSyntheticAffiliateClickContext(pool(), id(3));
    const [admitted, replay] = await Promise.all([
      admitSyntheticAffiliateClick(pool(), contextId, first.referenceToken),
      admitSyntheticAffiliateClick(pool(), contextId, first.referenceToken),
    ]);
    expect([admitted, replay]).toEqual(
      expect.arrayContaining([
        { status: "admitted", clickId: first.clickId, historyPosition: "1", replayed: false },
        { status: "admitted", clickId: first.clickId, historyPosition: "1", replayed: true },
      ]),
    );
    expect(await admitSyntheticAffiliateClick(pool(), contextId, second.referenceToken)).toEqual({
      status: "admitted",
      clickId: second.clickId,
      historyPosition: "2",
      replayed: false,
    });
    const another = await createSyntheticAffiliateClickContext(pool(), id(3));
    expect(await admitSyntheticAffiliateClick(pool(), another, first.referenceToken)).toEqual({
      status: "conflict",
    });
    const wrongProperty = await createSyntheticAffiliateClickContext(pool(), id(6));
    expect(
      await admitSyntheticAffiliateClick(pool(), wrongProperty, second.referenceToken),
    ).toEqual({
      status: "unavailable",
    });
    expect(await admitSyntheticAffiliateClick(pool(), contextId, "vc_invalid")).toEqual({
      status: "unavailable",
    });
    await expect(
      pool().query("UPDATE booking.affiliate_click_admissions SET history_position=3"),
    ).rejects.toThrow();
    await expect(pool().query("DELETE FROM booking.affiliate_click_admissions")).rejects.toThrow();
    await expect(
      pool().query("DELETE FROM booking.affiliate_click_contexts WHERE id=$1", [wrongProperty]),
    ).rejects.toThrow("Affiliate click context history is immutable");
    await expect(pool().query("TRUNCATE booking.affiliate_click_admissions")).rejects.toThrow(
      "Affiliate click context history is immutable",
    );
    await expect(pool().query("TRUNCATE booking.affiliate_click_contexts CASCADE")).rejects.toThrow(
      "Affiliate click context history is immutable",
    );
    expect(
      (await pool().query("SELECT count(*) FROM booking.affiliate_click_admissions")).rows[0].count,
    ).toBe("2");
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

  it("uses READ COMMITTED even when the database session defaults to REPEATABLE READ", async () => {
    const rrPool = new pg.Pool({ connectionString: pool().options.connectionString, max: 1 });
    try {
      await rrPool.query(
        "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      );
      expect(
        (await rrPool.query("SHOW default_transaction_isolation")).rows[0]
          .default_transaction_isolation,
      ).toBe("repeatable read");
      expect(await createMarketplaceAffiliateLink(rrPool, input(), ready)).toMatchObject({
        ok: true,
        agreementId,
      });
    } finally {
      await rrPool.end();
    }
  });

  it("blocks new links while paused and resolves the stable link only while active", async () => {
    const change = async (
      hotel: boolean,
      action: "pause" | "resume" | "end",
      expectedRevision: number,
    ) =>
      changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        context: assentInput(hotel).context,
        agreementId,
        action,
        reason: `${hotel ? "Hotel" : "Creator"} ${action}`,
        expectedRevision,
        idempotencyKey: `${action}-${expectedRevision}`,
      });
    const read = async (token: string) => {
      const client = await pool().connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const result = await readMarketplaceAffiliateLinkEligibility(client, token);
        await client.query("COMMIT");
        return result;
      } finally {
        client.release();
      }
    };

    expect(await change(true, "pause", 0)).toMatchObject({ ok: true, revision: 1 });
    expect(await createMarketplaceAffiliateLink(pool(), input(), ready)).toEqual({
      ok: false,
      code: "agreement_not_active",
    });
    expect(await change(true, "resume", 1)).toMatchObject({ ok: true, revision: 2 });
    const created = await createMarketplaceAffiliateLink(pool(), input(), ready);
    if (!created.ok) throw new Error("Expected link after resume");
    expect(await read(created.publicToken)).toMatchObject({
      status: "eligible",
      linkId: created.linkId,
    });
    expect(await read("invalid")).toEqual({ status: "unavailable" });

    expect(await change(false, "pause", 2)).toMatchObject({ ok: true, revision: 3 });
    expect(await read(created.publicToken)).toEqual({ status: "unavailable" });
    expect(await createMarketplaceAffiliateLink(pool(), input())).toMatchObject({
      ok: true,
      linkId: created.linkId,
      replayed: true,
    });
    expect(await change(false, "resume", 3)).toMatchObject({ ok: true, revision: 4 });
    expect(await read(created.publicToken)).toMatchObject({
      status: "eligible",
      linkId: created.linkId,
    });
    expect(await change(true, "end", 4)).toMatchObject({ ok: true, revision: 5 });
    expect(await read(created.publicToken)).toEqual({ status: "unavailable" });
  });

  it("orders a click eligibility read before a competing pause and rejects stale isolation", async () => {
    const created = await createMarketplaceAffiliateLink(pool(), input(), ready);
    if (!created.ok) throw new Error("Expected link");
    const reader = await pool().connect();
    let committed = false;
    let waiting = false;
    let pause: ReturnType<typeof changeMarketplaceAffiliateAgreementLifecycle> | undefined;
    try {
      await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(
        await readMarketplaceAffiliateLinkEligibility(reader, created.publicToken),
      ).toMatchObject({ status: "eligible", linkId: created.linkId });
      pause = changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        context: assentInput().context,
        agreementId,
        action: "pause",
        reason: "Hotel pause",
        expectedRevision: 0,
        idempotencyKey: "pause-behind-click",
      });
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (
          await pool().query(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'
               AND query LIKE '%JOIN marketplace.affiliate_agreement_activations a ON a.agreement_id=g.id%') AS waiting`,
          )
        ).rows[0].waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await reader.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await reader.query("ROLLBACK");
      reader.release();
    }
    expect(await pause).toMatchObject({ ok: true, revision: 1 });
    expect(waiting).toBe(true);

    const stale = await pool().connect();
    try {
      await expect(
        readMarketplaceAffiliateLinkEligibility(stale, created.publicToken),
      ).rejects.toMatchObject({
        code: "25P01",
      });
      await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await expect(
        readMarketplaceAffiliateLinkEligibility(stale, created.publicToken),
      ).rejects.toThrow("Affiliate link eligibility requires READ COMMITTED");
      await stale.query("ROLLBACK");
      await stale.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(await readMarketplaceAffiliateLinkEligibility(stale, created.publicToken)).toEqual({
        status: "unavailable",
      });
      await stale.query("COMMIT");
    } finally {
      stale.release();
    }
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
