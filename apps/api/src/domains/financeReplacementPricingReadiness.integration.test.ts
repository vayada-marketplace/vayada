import { randomUUID } from "node:crypto";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("replacement pricing Finance owner readiness", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  afterAll(() => pool.end());
  async function fixture(methods = ["pay_at_property"], currency = "EUR") {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1))) throw new Error("test database required");
    const propertyId = randomUUID(), accountId = randomUUID(), actorId = randomUUID(), organizationId = randomUUID();
    await pool.query("INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Finance pricing test')", [propertyId]);
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Finance pricing test')", [actorId, `${actorId}@example.test`]);
    await pool.query("INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Finance pricing test',$2)", [organizationId, organizationId]);
    await pool.query(`INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status,onboarding_status,
      charges_enabled,payouts_enabled,capabilities,card_capability_revision,account_metadata)
      VALUES($1,$2,'property','stripe',$3,'active','completed',true,true,ARRAY['card_payments'],1,'{"detailsSubmitted":true,"cardPaymentsStatus":"active"}')`,
    [accountId, propertyId, `acct_synthetic_${accountId}`]);
    // No retired PMS pricing row or v1 pricing-currency binding is needed by the new owner port.
    await pool.query(`INSERT INTO finance.payment_settings(property_id,provider_account_id,payments_enabled,accepted_methods,default_currency)
      VALUES($1,$2,true,$3,$4)`, [propertyId, accountId, methods, currency]);
    const terms: ReplacementOfferTerms[] = [{ roomTypeId: randomUUID(), offerId: "flex", revision: randomUUID(),
      cancellation: { kind: "flexible", terms: { type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 7,
        afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" } }, payment: { kind: "full" } }];
    const input = { propertyId, currency, pricingRevision: 1, terms };
    async function read(overrides: Partial<typeof input & { expectedEvidenceId: string }> = {}) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await lockPmsInventoryMutationScope(client, propertyId);
        return await lockFinanceReplacementPricingReadiness(client, { ...input, ...overrides });
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
    async function executionEvidence() {
      const id = randomUUID();
      await pool.query(`INSERT INTO finance.online_card_execution_evidence
        (id,property_id,provider_account_id,contract_version,test_suite,provider_capability_revision,property_readiness_revision,
          evidence_fingerprint_hash,executed_at,accepted_at,accepted_by_organization_id,accepted_by_user_id)
        SELECT $1,s.property_id,s.provider_account_id,'finance-online-card-execution-evidence.v1','onb-25a',a.card_capability_revision,
          s.online_card_readiness_revision,$2,now(),now(),$3,$4 FROM finance.payment_settings s
        JOIN finance.payment_provider_accounts a ON a.id=s.provider_account_id WHERE s.property_id=$5`,
      [id, id.replaceAll("-", "").repeat(2), organizationId, actorId, propertyId]);
      return id;
    }
    return { propertyId, accountId, input, read, executionEvidence };
  }
  it("binds pay-at-property capability to the new pricing and exact terms revisions", async () => {
    const f = await fixture(), first = await f.read();
    expect(first).toMatchObject({ kind: "ready", methods: ["pay_at_property"], pricingRevision: 1 });
    if (first.kind !== "ready") throw new Error("expected readiness");
    expect(await f.read({ expectedEvidenceId: first.evidenceId })).toEqual(first);
    expect(await f.read({ pricingRevision: 2, expectedEvidenceId: first.evidenceId })).toMatchObject({ reason: "stale" });
    expect(await f.read({ terms: [{ ...f.input.terms[0], revision: randomUUID() }], expectedEvidenceId: first.evidenceId })).toMatchObject({ reason: "stale" });
    expect(await f.read({ propertyId: randomUUID() })).toMatchObject({ reason: "settings_missing" });
  });
  it("fails explicitly for disabled payments, currency mismatch, unsupported methods and deposit execution", async () => {
    const f = await fixture();
    expect(await f.read({ currency: "USD" })).toMatchObject({ reason: "currency_mismatch" });
    expect(await f.read({ terms: [{ ...f.input.terms[0], payment: { kind: "deposit", basisPoints: 3000, balanceDaysBeforeArrival: 7 } }] })).toMatchObject({ reason: "deposit_execution_unavailable" });
    expect(await f.read({ terms: [] })).toMatchObject({ reason: "invalid" });
    await pool.query("UPDATE finance.payment_settings SET accepted_methods=ARRAY['bank_transfer'] WHERE property_id=$1", [f.propertyId]);
    expect(await f.read()).toMatchObject({ reason: "method_unavailable" });
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [f.propertyId]);
    expect(await f.read()).toMatchObject({ reason: "payments_disabled" });
  });
  it("requires actual scoped execution evidence and invalidates it when provider capability changes", async () => {
    const f = await fixture(["card"]), other = await fixture(["card"]);
    await other.executionEvidence();
    expect(await f.read()).toMatchObject({ reason: "method_unavailable" });
    await f.executionEvidence();
    expect(await f.read()).toMatchObject({ kind: "ready", methods: ["card"] });
    await pool.query("UPDATE finance.payment_provider_accounts SET charges_enabled=false WHERE id=$1", [f.accountId]);
    expect(await f.read()).toMatchObject({ reason: "method_unavailable" });
    await pool.query("UPDATE finance.payment_provider_accounts SET charges_enabled=true WHERE id=$1", [f.accountId]);
    expect(await f.read()).toMatchObject({ reason: "method_unavailable" });
  });
  it("respects Finance currency limitations without suppressing independent pay-at-property", async () => {
    const f = await fixture(["card", "pay_at_property"], "KWD");
    await f.executionEvidence();
    expect(await f.read()).toMatchObject({ kind: "ready", methods: ["pay_at_property"] });
    await pool.query("UPDATE finance.payment_settings SET accepted_methods=ARRAY['card'] WHERE property_id=$1", [f.propertyId]);
    expect(await f.read()).toMatchObject({ reason: "method_unavailable" });
  });
  it("locks Finance settings, provider capability and accepted evidence until the transaction ends", async () => {
    const f = await fixture(["card"]), evidenceId = await f.executionEvidence(), client = await pool.connect(), concurrent = await pool.connect();
    try {
      await client.query("BEGIN"); await lockPmsInventoryMutationScope(client, f.propertyId);
      expect(await lockFinanceReplacementPricingReadiness(client, f.input)).toMatchObject({ kind: "ready" });
      await concurrent.query("SET statement_timeout='150ms'");
      for (const [sql, id] of [
        ["UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", f.propertyId],
        ["UPDATE finance.payment_provider_accounts SET status='restricted' WHERE id=$1", f.accountId],
        ["UPDATE finance.online_card_execution_evidence SET revoked_at=now() WHERE id=$1", evidenceId],
      ]) await expect(concurrent.query(sql, [id])).rejects.toMatchObject({ code: "57014" });
      await client.query("ROLLBACK");
      await concurrent.query("UPDATE finance.online_card_execution_evidence SET revoked_at=now() WHERE id=$1", [evidenceId]);
      expect(await f.read()).toMatchObject({ reason: "method_unavailable" });
    } finally { await client.query("ROLLBACK"); await concurrent.query("RESET statement_timeout"); client.release(); concurrent.release(); }
  });
});
