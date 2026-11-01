import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import type { AcceptFinanceOnlineCardExecutionEvidenceCommand } from "@vayada/domain-finance";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFinanceOnlineCardExecutionEvidenceRepository } from "../routes/financeOnlineCardExecutionEvidenceRepository.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const OLD = "finance.online_card_readiness";
const NEW = "finance.online_card_readiness_by_provider";
const userId = randomUUID(),
  organizationId = randomUUID();

type State = {
  provider?: "stripe" | "xendit" | "vayada";
  reference?: (propertyId: string) => string | null;
  status?: string;
  payouts?: boolean;
  card?: boolean;
  evidence?: "current" | "stale" | "revoked" | null;
  stripeVerified?: boolean;
};

// Every hotel shape the readiness views can see. The non-vayada ones must read the same in both.
const states: Record<string, State> = {
  stripeReady: { provider: "stripe", evidence: "current" },
  stripeNoApproval: { provider: "stripe", evidence: null },
  stripeStaleApproval: { provider: "stripe", evidence: "stale" },
  stripeRevoked: { provider: "stripe", evidence: "revoked" },
  stripeUnverified: { provider: "stripe", evidence: "current", stripeVerified: false },
  stripeRestricted: { provider: "stripe", evidence: "current", status: "restricted" },
  stripePlaceholder: {
    provider: "stripe",
    reference: (id) => `settings-choice:${id}:stripe`,
    evidence: "current",
  },
  stripeCardOff: { provider: "stripe", evidence: "current", card: false },
  noAccount: {},
  xendit: { provider: "xendit", reference: () => `xnd_${randomUUID()}`, evidence: "current" },
  vayadaReady: { provider: "vayada", evidence: "current" },
  vayadaNoApproval: { provider: "vayada", evidence: null },
  vayadaPlaceholder: {
    provider: "vayada",
    reference: (id) => `settings-choice:${id}:vayada`,
    evidence: "current",
  },
  vayadaPayoutsOff: { provider: "vayada", evidence: "current", payouts: false },
  vayadaImportedNoReference: { provider: "vayada", reference: () => null, evidence: "current" },
  vayadaOtherProperty: {
    provider: "vayada",
    reference: () => `vayada:${randomUUID()}`,
    evidence: "current",
  },
  vayadaCardOff: { provider: "vayada", evidence: "current", card: false },
  vayadaStaleApproval: { provider: "vayada", evidence: "stale" },
};
const ids = Object.fromEntries(Object.keys(states).map((name) => [name, randomUUID()]));

describe.skipIf(!url)("card readiness per provider (VAY-2442)", () => {
  const pool = new pg.Pool({ connectionString: url ?? "postgresql://disabled", max: 4 });

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO identity.users(id,email,name,status) VALUES ($1,$2,'T','active')",
      [userId, `${userId}@example.test`],
    );
    await pool.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-2442', $2, 'active')`,
      [organizationId, `vay-2442-${organizationId}`],
    );
    for (const [name, state] of Object.entries(states)) await seed(ids[name]!, state);
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const table of [
        "platform.outbox_events",
        "platform.domain_events",
        "platform.product_audit_events",
        "platform.idempotency_keys",
        "finance.online_card_execution_evidence",
        "finance.payment_settings",
        "finance.payment_provider_accounts",
        "pms.property_pricing_settings",
      ])
        await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [
          Object.values(ids),
        ]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        Object.values(ids),
      ]);
      await client.query("DELETE FROM identity.organizations WHERE id = $1", [organizationId]);
      await client.query("DELETE FROM identity.users WHERE id = $1", [userId]);
      await client.query("COMMIT");
    } finally {
      client.release();
      await pool.end();
    }
  });

  async function seed(propertyId: string, state: State) {
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ($1::uuid,$1::text,'T')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO pms.property_pricing_settings (property_id, currency, pricing_currency_revision)
       VALUES ($1::uuid, 'EUR', 1)`,
      [propertyId],
    );
    let accountId: string | null = null;
    if (state.provider) {
      const reference = state.reference
        ? state.reference(propertyId)
        : state.provider === "vayada"
          ? `vayada:${propertyId}`
          : `acct_${randomUUID().replaceAll("-", "")}`;
      const metadata =
        state.provider === "stripe" && state.stripeVerified !== false
          ? { detailsSubmitted: true, cardPaymentsStatus: "active" }
          : {};
      accountId = (
        await pool.query<{ id: string }>(
          `INSERT INTO finance.payment_provider_accounts (property_id, account_scope, provider,
             provider_account_id, status, onboarding_status, charges_enabled, payouts_enabled,
             default_currency, capabilities, account_metadata, card_capability_revision)
           VALUES ($1::uuid,'property',$2,$3,$4,'completed',TRUE,$5,'EUR',ARRAY['card_payments'],$6::jsonb,3)
           RETURNING id::text`,
          [
            propertyId,
            state.provider,
            reference,
            state.status ?? "active",
            state.payouts ?? true,
            JSON.stringify(metadata),
          ],
        )
      ).rows[0]!.id;
    }
    await pool.query(
      `INSERT INTO finance.payment_settings (property_id, provider_account_id, payments_enabled,
         accepted_methods, default_currency, payment_readiness_contract_version,
         payment_methods_revision, source_pricing_currency_revision)
       VALUES ($1::uuid, $2::uuid, TRUE, $3::text[], 'EUR', 'finance-payment-readiness.v1', 1, 1)`,
      [
        propertyId,
        accountId,
        state.card === false ? ["pay_at_property"] : ["card", "pay_at_property"],
      ],
    );
    if (accountId && state.evidence)
      await pool.query(
        `INSERT INTO finance.online_card_execution_evidence (property_id, provider_account_id,
           contract_version, test_suite, provider_capability_revision, property_readiness_revision,
           evidence_fingerprint_hash, executed_at, accepted_at, accepted_by_organization_id,
           accepted_by_user_id, revoked_at)
         VALUES ($1::uuid, $2::uuid, 'finance-online-card-execution-evidence.v1', 'onb-25a', $3, 1,
           $4, now() - interval '1 hour', now() - interval '1 hour', $5::uuid, $6::uuid, $7)`,
        [
          propertyId,
          accountId,
          state.evidence === "stale" ? 2 : 3,
          "c".repeat(64),
          organizationId,
          userId,
          state.evidence === "revoked" ? new Date() : null,
        ],
      );
  }

  const row = async (view: string, propertyId: string) =>
    (await pool.query(`SELECT * FROM ${view} WHERE property_id = $1::uuid`, [propertyId])).rows[0];

  it("reads every hotel not on vayada Payment exactly as online_card_readiness does", async () => {
    // Whole views, not only this test's hotels: same rows, and row for row the same values.
    const count = async (view: string) =>
      Number((await pool.query(`SELECT count(*) FROM ${view}`)).rows[0].count);
    expect(await count(NEW)).toBe(await count(OLD));
    for (const [left, right] of [
      [OLD, NEW],
      [NEW, OLD],
    ])
      expect(
        (
          await pool.query(
            `SELECT * FROM ${left} WHERE provider IS DISTINCT FROM 'vayada'
             EXCEPT ALL SELECT * FROM ${right} WHERE provider IS DISTINCT FROM 'vayada'`,
          )
        ).rows,
      ).toEqual([]);
    // The comparison covers the shapes seeded here (it isn't vacuous).
    expect((await row(NEW, ids.stripeReady!)).online_card_ready).toBe(true);
    for (const name of [
      "stripeNoApproval",
      "stripeStaleApproval",
      "stripeRevoked",
      "stripeUnverified",
      "stripeRestricted",
      "stripePlaceholder",
      "stripeCardOff",
      "noAccount",
      "xendit",
    ])
      expect(await row(NEW, ids[name]!)).toEqual(await row(OLD, ids[name]!));

    // Same columns, in the same order and of the same types; both views run as the caller.
    const columns = async (view: string) =>
      (
        await pool.query(
          `SELECT column_name, data_type, udt_name FROM information_schema.columns
           WHERE table_schema = 'finance' AND table_name = $1 ORDER BY ordinal_position`,
          [view.split(".")[1]],
        )
      ).rows;
    expect(await columns(NEW)).toEqual(await columns(OLD));
    const options = async (view: string) =>
      (await pool.query(`SELECT reloptions FROM pg_class WHERE oid = $1::regclass`, [view])).rows[0]
        .reloptions;
    expect(await options(OLD)).toEqual(["security_invoker=true"]);
    expect(await options(NEW)).toEqual(["security_invoker=true"]);
  });

  it("makes vayada Payment ready only when bound to the hotel, with payouts, card and a current approval", async () => {
    const expected: Record<string, [binding: boolean, ready: boolean]> = {
      vayadaReady: [true, true],
      vayadaNoApproval: [true, false],
      vayadaPlaceholder: [false, false],
      vayadaPayoutsOff: [true, false],
      vayadaImportedNoReference: [false, false],
      vayadaOtherProperty: [false, false],
      vayadaCardOff: [true, false],
      vayadaStaleApproval: [true, false],
    };
    for (const [name, [binding, ready]] of Object.entries(expected)) {
      const next = await row(NEW, ids[name]!);
      const previous = await row(OLD, ids[name]!);
      expect([name, next.provider_binding_active, next.online_card_ready]).toEqual([
        name,
        binding,
        ready,
      ]);
      // Before this view, no vayada hotel could be card-ready.
      expect(previous.online_card_ready).toBe(false);
      const rest = (value: Record<string, unknown>) => {
        const copy = { ...value };
        delete copy.provider_binding_active;
        delete copy.online_card_ready;
        return copy;
      };
      expect(rest(next)).toEqual(rest(previous));
    }
  });

  it("sells card in published prices exactly when the booking page shows it ready", async () => {
    // The published-price check computes readiness in TypeScript; the booking page reads the view.
    const terms: ReplacementOfferTerms[] = [
      {
        roomTypeId: randomUUID(),
        offerId: "flex",
        revision: randomUUID(),
        cancellation: {
          kind: "flexible",
          terms: {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays: 7,
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
        },
        payment: { kind: "full" },
      },
    ];
    for (const name of Object.keys(states)) {
      const client = await pool.connect();
      let sellsCard: boolean;
      try {
        await client.query("BEGIN");
        const readiness = await lockFinanceReplacementPricingReadiness(client, {
          propertyId: ids[name]!,
          currency: "EUR",
          pricingRevision: 1,
          terms,
        });
        sellsCard = readiness.kind === "ready" && readiness.methods.includes("card");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect([name, sellsCard]).toEqual([name, (await row(NEW, ids[name]!)).online_card_ready]);
    }
  });

  it("lets Vayada approve a bound vayada Payment account only while the switch is on", async () => {
    const off = createFinanceOnlineCardExecutionEvidenceRepository(pool);
    const on = createFinanceOnlineCardExecutionEvidenceRepository(pool, {
      vayadaPaymentEnabled: true,
    });
    const propertyId = ids.vayadaNoApproval!;
    // Off: Vayada sees the account (so it can still withdraw an approval) but can't approve it.
    expect(await off.readOnlineCardExecutionState(propertyId)).toMatchObject({
      providerAccount: { ready: true, cardCapabilityRevision: 3 },
    });
    expect(await off.acceptOnlineCardExecutionEvidence(accept(propertyId))).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "provider_capability_unavailable",
    });
    // A placeholder or an account without payouts is never approvable.
    expect(await on.readOnlineCardExecutionState(ids.vayadaPlaceholder!)).toMatchObject({
      providerAccount: null,
    });
    expect(await on.readOnlineCardExecutionState(ids.vayadaPayoutsOff!)).toMatchObject({
      providerAccount: { ready: false },
    });
    expect(await on.acceptOnlineCardExecutionEvidence(accept(ids.vayadaPayoutsOff!))).toMatchObject(
      { ok: false, code: "provider_capability_unavailable" },
    );

    expect(await on.readOnlineCardExecutionState(propertyId)).toMatchObject({
      providerAccount: { ready: true, cardCapabilityRevision: 3 },
      cardReady: false,
    });
    expect(await on.acceptOnlineCardExecutionEvidence(accept(propertyId))).toMatchObject({
      ok: true,
      status: "accepted",
      response: { cardReady: true },
    });
    expect((await row(NEW, propertyId)).online_card_ready).toBe(true);
    expect((await row(OLD, propertyId)).online_card_ready).toBe(false);
    // After switching off, the approval is still listed, so it can be withdrawn.
    expect(await off.readOnlineCardExecutionState(propertyId)).toMatchObject({
      evidence: { current: true },
      cardReady: true,
    });

    // Removing the payout account turns payouts off (P1): the approval no longer counts.
    await pool.query(
      `UPDATE finance.payment_provider_accounts SET payouts_enabled = FALSE
       WHERE property_id = $1::uuid AND provider = 'vayada'`,
      [propertyId],
    );
    expect((await row(NEW, propertyId)).online_card_ready).toBe(false);
  });

  function accept(propertyId: string): AcceptFinanceOnlineCardExecutionEvidenceCommand {
    return {
      commandType: "finance.online_card_execution_evidence.accept",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      propertyId,
      audit: {
        actor: { kind: "user", userId, organizationId },
        requestId: "request-vay-2442",
        correlationId: "correlation-vay-2442",
        reason: "Approve vayada Payment for the test hotel",
        requestedAt: new Date().toISOString(),
      },
      payload: {
        expectedCardCapabilityRevision: 3,
        expectedPropertyReadinessRevision: 1,
        evidenceFingerprintHash: "d".repeat(64),
        executedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    };
  }
});
