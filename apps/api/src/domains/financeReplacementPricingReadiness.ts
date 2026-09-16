import { createHash } from "node:crypto";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import { resolveFinanceOnlineCardReadiness } from "@vayada/domain-finance";
import { pricingCurrencyScale, pricingInteger, pricingObject } from "@vayada/domain-pms";
import type { PoolClient } from "pg";
import { parseBookingPricingOfferTerms } from "./bookingPricingOfferTerms.js";

type Method = "card" | "pay_at_property";
export type FinanceReplacementPricingReadiness =
  | { kind: "ready"; evidenceId: string; propertyId: string; currency: string; pricingRevision: number; methods: readonly Method[] }
  | { kind: "unavailable"; reason: "invalid" | "settings_missing" | "payments_disabled" | "currency_mismatch" |
      "method_unavailable" | "deposit_execution_unavailable" | "stale" };

/** Finance-owned, read-only port inside the caller's authorized property transaction.
 * Pricing and terms must be loaded/verified through their owners before calling.
 * Method capability is not checkout or publication approval. No v1 pricing revision is fabricated. */
export async function lockFinanceReplacementPricingReadiness(client: PoolClient, input: {
  propertyId: string; currency: string; pricingRevision: number; terms: readonly ReplacementOfferTerms[]; expectedEvidenceId?: string;
}): Promise<FinanceReplacementPricingReadiness> {
  const unavailable = (reason: Extract<FinanceReplacementPricingReadiness, { kind: "unavailable" }>["reason"]): FinanceReplacementPricingReadiness => ({ kind: "unavailable", reason });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.propertyId) || pricingCurrencyScale(input.currency) === null || !pricingInteger(input.pricingRevision, 1) ||
      input.pricingRevision > 2147483647 || !Array.isArray(input.terms) || !input.terms.length) return unavailable("invalid");
  const terms = Array.from(input.terms, parseBookingPricingOfferTerms);
  if (terms.some((t) => !t) || new Set(terms.map((t) => JSON.stringify([t!.roomTypeId, t!.offerId]))).size !== terms.length) return unavailable("invalid");
  const request = structuredClone({ ...input, propertyId: input.propertyId.toLowerCase(), terms: terms as ReplacementOfferTerms[] });
  const settings = (await client.query(`SELECT payments_enabled,accepted_methods,default_currency,provider_account_id,
    payment_methods_revision,online_card_readiness_revision FROM finance.payment_settings WHERE property_id=$1 FOR SHARE`, [request.propertyId])).rows[0];
  if (!settings) return unavailable("settings_missing");
  if (!settings.payments_enabled) return unavailable("payments_disabled");
  if (settings.default_currency !== request.currency) return unavailable("currency_mismatch");
  if (!Array.isArray(settings.accepted_methods) || new Set(settings.accepted_methods).size !== settings.accepted_methods.length) return unavailable("invalid");
  // The current execution contract does not establish split-payment/deposit support.
  if (request.terms.some((t) => t.payment.kind === "deposit")) return unavailable("deposit_execution_unavailable");
  const methods: Method[] = [];
  if (settings.accepted_methods.includes("pay_at_property")) methods.push("pay_at_property");
  let cardSource: unknown = null;
  if (settings.accepted_methods.includes("card") && settings.provider_account_id) {
    const account = (await client.query(`SELECT id,provider,account_scope,provider_account_id,status,onboarding_status,
      charges_enabled,payouts_enabled,capabilities,card_capability_revision,account_metadata
      FROM finance.payment_provider_accounts WHERE property_id=$1 AND id=$2 FOR SHARE`, [request.propertyId, settings.provider_account_id])).rows[0];
    if (account) {
      if (!pricingObject(account.account_metadata)) return unavailable("invalid");
      const evidence = (await client.query(`SELECT id,contract_version,provider_account_id,provider_capability_revision,
        property_readiness_revision,revoked_at,accepted_at FROM finance.online_card_execution_evidence
        WHERE property_id=$1 AND provider_account_id=$2 AND revoked_at IS NULL FOR SHARE`, [request.propertyId, account.id])).rows[0];
      // Reuse Finance's current currency gate; no provider currency rules are copied into pricing.
      const view = (await client.query("SELECT currency_eligible FROM finance.online_card_readiness WHERE property_id=$1", [request.propertyId])).rows[0];
      const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      const providerAccount = {
        id: account.id, provider: account.provider, accountScope: account.account_scope,
        providerBindingActive: typeof account.provider_account_id === "string" && !account.provider_account_id.startsWith("settings-choice:"),
        status: account.status, onboardingStatus: account.onboarding_status, chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled, detailsSubmitted: account.account_metadata.detailsSubmitted === true,
        cardPaymentsStatus: account.account_metadata.cardPaymentsStatus ?? null, capabilities: account.capabilities,
        cardCapabilityRevision: Number(account.card_capability_revision),
      };
      const executionEvidence = evidence && evidence.accepted_at <= now ? {
        contractVersion: evidence.contract_version, providerAccountId: evidence.provider_account_id,
        providerCapabilityRevision: Number(evidence.provider_capability_revision),
        propertyReadinessRevision: Number(evidence.property_readiness_revision), revokedAt: null,
      } : null;
      cardSource = { providerAccount, executionEvidence, executionEvidenceId: evidence?.id ?? null };
      try {
        if (resolveFinanceOnlineCardReadiness({ currencyEligible: view?.currency_eligible === true,
          propertyReadinessRevision: Number(settings.online_card_readiness_revision), providerAccount, executionEvidence }) === "ready") methods.push("card");
      } catch { return unavailable("invalid"); }
    }
  }
  if (!methods.length) return unavailable("method_unavailable");
  const orderedTerms = request.terms.map((t) => [t.roomTypeId, t.offerId, t.revision]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const evidenceId = "finance.pricing.v2:" + createHash("sha256").update(JSON.stringify({
    propertyId: request.propertyId, currency: request.currency, pricingRevision: request.pricingRevision,
    terms: orderedTerms, settings, cardSource, methods,
  })).digest("hex");
  if (request.expectedEvidenceId !== undefined && request.expectedEvidenceId !== evidenceId) return unavailable("stale");
  return { kind: "ready", evidenceId, propertyId: request.propertyId, currency: request.currency, pricingRevision: request.pricingRevision, methods };
}
