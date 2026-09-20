import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { assentCommandFixture, assentInput } from "./affiliateAssentCommandTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import {
  activateMarketplaceAffiliateAgreement,
  type AffiliateAgreementActivationReadiness,
} from "./marketplaceAffiliateAgreementActivation.js";
import { recordAffiliateAssent } from "./marketplaceAffiliateAssentCommand.js";
import { readMarketplaceAffiliateAgreementLifecycle } from "./marketplaceAffiliateAgreementLifecycle.js";
import { changeMarketplaceAffiliateAgreementLifecycle } from "./marketplaceAffiliateAgreementLifecycleCommand.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);

describe.skipIf(!databaseUrl)("affiliate agreement lifecycle command", () => {
  const fixture = assentCommandFixture();
  const pool = () => fixture.pool();
  let agreementId: string;
  const ready: AffiliateAgreementActivationReadiness = async (_client, scope) => ({
    status: "ready",
    scope,
    enrollmentOpen: true,
    evidenceReferences: ["synthetic-commercial-proof", "synthetic-tracking-proof"],
  });

  beforeEach(async () => {
    await pool().query(
      await readFile(
        new URL("0214_marketplace_affiliate_agreement_activation.sql", migrations),
        "utf8",
      ),
    );
    await pool().query(
      await readFile(
        new URL("0326_marketplace_affiliate_agreement_lifecycle.sql", migrations),
        "utf8",
      ),
    );
    expect(await recordAffiliateAssent(pool(), assentInput())).toMatchObject({ ok: true });
    expect(
      await recordAffiliateAssent(pool(), { ...assentInput(false), expectedRevision: 1 }),
    ).toMatchObject({ ok: true, state: "matched" });
    const activated = await activateMarketplaceAffiliateAgreement(
      pool(),
      {
        context: assentInput().context,
        propertyId: id(3),
        programId: id(50),
        creatorProfileId: id(82),
        attemptId: id(100),
        termsId: id(51),
        expectedRevision: 0,
        idempotencyKey: "activate",
      },
      ready,
    );
    if (!activated.ok) throw new Error(`Activation failed: ${activated.code}`);
    agreementId = activated.agreementId;
  });

  const input = (hotel = true) => ({
    context: assentInput(hotel).context,
    agreementId,
    action: "pause" as const,
    reason: "Partner requested pause",
    expectedRevision: 0,
    idempotencyKey: "pause-hotel",
  });

  async function status() {
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

  it("keeps both sides' pauses independent and makes end terminal", async () => {
    const hotelPause = await changeMarketplaceAffiliateAgreementLifecycle(pool(), input());
    expect(hotelPause).toMatchObject({ ok: true, revision: 1, replayed: false });
    expect(await status()).toEqual({ status: "paused", revision: 1, pausedBy: ["hotel"] });
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(false),
        expectedRevision: 1,
        idempotencyKey: "pause-creator",
      }),
    ).toMatchObject({ ok: true, revision: 2 });
    expect(await status()).toEqual({
      status: "paused",
      revision: 2,
      pausedBy: ["hotel", "creator"],
    });
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(),
        action: "resume",
        expectedRevision: 2,
        idempotencyKey: "resume-hotel",
      }),
    ).toMatchObject({ ok: true, revision: 3 });
    expect(await status()).toEqual({ status: "paused", revision: 3, pausedBy: ["creator"] });
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(false),
        action: "resume",
        expectedRevision: 3,
        idempotencyKey: "resume-creator",
      }),
    ).toMatchObject({ ok: true, revision: 4 });
    expect(await status()).toEqual({ status: "active", revision: 4, pausedBy: [] });
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(false),
        action: "end",
        expectedRevision: 4,
        idempotencyKey: "end-creator",
      }),
    ).toMatchObject({ ok: true, revision: 5 });
    expect(await status()).toEqual({ status: "ended", revision: 5, pausedBy: [] });
    expect(await changeMarketplaceAffiliateAgreementLifecycle(pool(), input())).toEqual({
      ...hotelPause,
      replayed: true,
    });
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(),
        expectedRevision: 5,
        idempotencyKey: "after-end",
      }),
    ).toEqual({ ok: false, code: "transition_unavailable" });
  });

  it("returns the original event on retry and rejects stale or changed requests", async () => {
    const first = await changeMarketplaceAffiliateAgreementLifecycle(pool(), input());
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(await changeMarketplaceAffiliateAgreementLifecycle(pool(), input())).toEqual({
      ...first,
      replayed: true,
    });
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(),
        reason: "Different reason",
      }),
    ).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(),
        idempotencyKey: "new-key-stale",
      }),
    ).toEqual({ ok: false, code: "revision_conflict" });
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(),
        expectedRevision: 1,
        idempotencyKey: "duplicate-pause",
      }),
    ).toEqual({ ok: false, code: "transition_unavailable" });
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_agreement_lifecycle_events"))
        .rows[0].count,
    ).toBe("1");
  });

  it("authorizes again before retry and rejects revoked or foreign scope", async () => {
    await changeMarketplaceAffiliateAgreementLifecycle(pool(), input());
    const revoked = input();
    revoked.context.linkedResources = [];
    await expect(changeMarketplaceAffiliateAgreementLifecycle(pool(), revoked)).rejects.toThrow();
    await pool().query(
      "UPDATE identity.organization_resource_links SET status='inactive' WHERE organization_id=$1",
      [id(4)],
    );
    expect(await changeMarketplaceAffiliateAgreementLifecycle(pool(), input())).toEqual({
      ok: false,
      code: "scope_unavailable",
    });
    const foreign = input(false);
    foreign.context.selectedOrganization.organizationId = id(4);
    expect(await changeMarketplaceAffiliateAgreementLifecycle(pool(), foreign)).toEqual({
      ok: false,
      code: "scope_unavailable",
    });
  });

  it("serializes competing changes and rejects an invalid transition", async () => {
    expect(
      await changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(),
        action: "resume",
      }),
    ).toEqual({ ok: false, code: "transition_unavailable" });
    const [first, second] = await Promise.all([
      changeMarketplaceAffiliateAgreementLifecycle(pool(), input()),
      changeMarketplaceAffiliateAgreementLifecycle(pool(), {
        ...input(false),
        idempotencyKey: "creator-competes",
      }),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      { ok: false, code: "revision_conflict" },
    ]);
    expect(await status()).toMatchObject({ status: "paused", revision: 1 });
  });
});
