import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createPgProviderWebhookStore } from "../platform/providerWebhooks.js";
import { createTargetFinancePropertySettingsRepository } from "../routes/finance.js";
import { paymentRepublishFixture } from "./pricingPaymentRepublish.fixtures.js";
import { replacementChargeFingerprint } from "./replacementChargeDeclarations.js";
import { readCurrentPricingSnapshot } from "./replacementPricingSnapshot.js";
import {
  republishPricingAfterCommit,
  republishPricingAfterPaymentChanges,
} from "./pricingPaymentRepublish.js";

const url = process.env["TEST_DATABASE_URL"];
// Vayada Platform's seeded id, the organization of Vayada Admin's card switch.
const platformOrganizationId = "00000000-0000-0000-0000-000000000001";

// VAY-2304: every payment write re-publishes the hotel's prices right after it commits, and a
// sweep catches the rest, including hotels a release staled.
describe.skipIf(!url)("payment changes re-publish prices", () => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const afterPaymentChange = (p: pg.Pool, propertyId: string) =>
    republishPricingAfterCommit(p, propertyId);
  const finance = createTargetFinancePropertySettingsRepository({
    connectionString: url ?? "postgresql://integration-test-disabled",
    pool,
    afterPaymentChange,
  });
  beforeAll(async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    await pool.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
      VALUES ($1, 'platform', 'Vayada Platform', 'vayada-platform', 'active') ON CONFLICT DO NOTHING`,
      [platformOrganizationId],
    );
  });
  afterAll(() => pool.end());

  const actor = (userId: string, organizationId: string) => ({
    actor: { kind: "user" as const, userId, organizationId },
    requestId: randomUUID(),
    reason: "VAY-2304 test",
    requestedAt: new Date().toISOString(),
  });
  const latest = async (propertyId: string) =>
    (
      await pool.query(
        `SELECT revision, actor_type FROM pms.pricing_v2_revisions WHERE property_id=$1
        ORDER BY revision DESC LIMIT 1`,
        [propertyId],
      )
    ).rows[0];

  it("re-publishes right after the hotel saves its payment settings", async () => {
    const f = await paymentRepublishFixture(pool, ["pay_at_property"]);
    await (
      await f.save(0)
    )();
    await expect(
      finance.updatePaymentSettings!({
        commandType: "finance.payment_settings.update",
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        propertyId: f.propertyId,
        audit: actor(f.actorUserId, f.organizationId),
        payload: { paymentsEnabled: true, acceptedMethods: ["pay_at_property", "cash"] },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(await latest(f.propertyId)).toEqual({ revision: 2, actor_type: "system" });
    expect(await f.served()).toMatchObject({ publication: { revision: 2 } });
  });

  it("re-publishes when Vayada Admin turns card off and on, each time with the methods it can take", async () => {
    const f = await paymentRepublishFixture(pool, ["card", "pay_at_property"], true);
    const approval = await f.cardOn();
    await (
      await f.save(0)
    )();
    await expect(
      finance.revokeOnlineCardExecutionEvidence!({
        commandType: "finance.online_card_execution_evidence.revoke",
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        propertyId: f.propertyId,
        audit: actor(f.actorUserId, platformOrganizationId),
        payload: { evidenceId: approval },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(await latest(f.propertyId)).toEqual({ revision: 2, actor_type: "system" });
    expect((await f.served())?.finance).toMatchObject({ methods: ["pay_at_property"] });

    const revisions = (
      await pool.query(
        `SELECT a.card_capability_revision::int AS card, s.online_card_readiness_revision::int AS property
        FROM finance.payment_settings s JOIN finance.payment_provider_accounts a ON a.id=s.provider_account_id
        WHERE s.property_id=$1`,
        [f.propertyId],
      )
    ).rows[0];
    await expect(
      finance.acceptOnlineCardExecutionEvidence!({
        commandType: "finance.online_card_execution_evidence.accept",
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        propertyId: f.propertyId,
        audit: actor(f.actorUserId, platformOrganizationId),
        payload: {
          expectedCardCapabilityRevision: revisions.card,
          expectedPropertyReadinessRevision: revisions.property,
          evidenceFingerprintHash: "b".repeat(64),
          executedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(await latest(f.propertyId)).toEqual({ revision: 3, actor_type: "system" });
    expect((await f.served())?.finance).toMatchObject({ methods: ["pay_at_property", "card"] });
  });

  it("re-publishes after a Stripe account webhook: card stops, pay at the property sells on", async () => {
    const f = await paymentRepublishFixture(pool, ["card", "pay_at_property"], true);
    await f.cardOn();
    await (
      await f.save(0)
    )();
    const providerAccountRef = `acct_synthetic_${f.accountId}`;
    const secret = "whsec_vay_2304_integration";
    const now = new Date();
    const body = JSON.stringify({
      id: `evt_vay_2304_${randomUUID()}`,
      type: "account.updated",
      data: { object: { id: providerAccountRef, charges_enabled: true, payouts_enabled: false } },
    });
    const timestamp = Math.floor(now.getTime() / 1_000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const app = buildApp({
      providerWebhooks: {
        secrets: { stripe: secret },
        modes: { stripe: "mutating" },
        store: createPgProviderWebhookStore({
          connectionString: url!,
          stripeConnectProvider: {
            // Stripe now reports payouts off: the account is no longer ready for card.
            retrieveAccount: async ({ providerAccountRef: ref }) => ({
              providerAccountRef: ref,
              chargesEnabled: true,
              payoutsEnabled: false,
              detailsSubmitted: true,
              cardPaymentsStatus: "active",
              defaultCurrency: "eur",
            }),
          },
          afterPaymentChange,
        }),
        now: () => now,
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": `t=${timestamp},v1=${signature}`,
        },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
    expect(await latest(f.propertyId)).toEqual({ revision: 2, actor_type: "system" });
    expect((await f.served())?.finance).toMatchObject({ methods: ["pay_at_property"] });
  });

  it("the sweep catches up a hotel a release staled and names the ones it leaves to the hotel", async () => {
    const staled = await paymentRepublishFixture(pool, ["pay_at_property"]);
    const current = await paymentRepublishFixture(pool, ["pay_at_property"]);
    const edited = await paymentRepublishFixture(pool, ["pay_at_property"]);
    const unpublished = await paymentRepublishFixture(pool, ["pay_at_property"]);
    for (const f of [staled, current, edited]) await (await f.save(0))();
    // A release that changes the Finance fingerprint formula, as #3027 did on 2026-10-10: the
    // published token no longer matches, although the payment setup itself never changed. The
    // hotel's charges declaration was made with the token of its day, so it binds the old one too.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const published = (await readCurrentPricingSnapshot(client, staled.propertyId))!;
      const old = { ...published.sources, finance: "finance.pricing.source.v1:old-formula" };
      await client.query(
        "UPDATE pms.pricing_v2_revisions SET source_revisions = $2 WHERE property_id = $1",
        [staled.propertyId, JSON.stringify(old)],
      );
      await client.query(
        "UPDATE pms.pricing_v2_charge_declarations SET fingerprint = $2 WHERE id = $1",
        [
          published.ownerReferences.charges,
          replacementChargeFingerprint(
            staled.propertyId,
            {
              currency: published.currency,
              rooms: published.rooms,
              ownerReferences: published.ownerReferences,
            },
            old,
          ),
        ],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await staled.served()).toBeNull();
    // Another hotel changed its payment setup and a rate's terms: that publish is the hotel's.
    await pool.query(
      "UPDATE finance.payment_settings SET tax_policy='{\"version\":2}'::jsonb WHERE property_id=$1",
      [edited.propertyId],
    );
    await edited.changeTerms();

    const ids = [staled, current, edited, unpublished].map((f) => f.propertyId);
    expect(await republishPricingAfterPaymentChanges(pool, ids)).toEqual({
      checked: 3,
      republished: 1,
      republishedProperties: [staled.propertyId],
      skipped: { room_or_terms_changed: 1 },
      skippedProperties: { room_or_terms_changed: [edited.propertyId] },
      lockTimeouts: 0,
      failed: 0,
    });
    expect(await staled.served()).toMatchObject({ publication: { revision: 2 } });
    expect(await latest(current.propertyId)).toEqual({ revision: 1, actor_type: "user" });
    // The next run finds nothing more to do.
    expect(await republishPricingAfterPaymentChanges(pool, ids)).toMatchObject({
      republished: 0,
      skipped: { room_or_terms_changed: 1 },
    });
  });
});
