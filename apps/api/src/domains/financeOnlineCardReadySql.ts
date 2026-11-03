/**
 * VAY-2442 (Flamur, 2026-11-03): guests can pay by card as soon as the hotel's own payment
 * settings and its provider account are complete. Vayada no longer approves card per hotel.
 *
 * This is the SQL twin of `resolveFinanceOnlineCardReadiness` (@vayada/domain-finance), over
 * `finance.online_card_readiness_by_provider` (`readiness`) and the hotel's
 * `finance.payment_settings` (`settings`):
 * - the hotel takes payments, has card selected under the current payment readiness contract,
 *   and its currency can take cards;
 * - its provider account is the hotel's own and in good standing: Stripe Connect verified with
 *   card payments active, or vayada Payment bound as `vayada:<property>` with its payout account
 *   saved (payouts on).
 *
 * The view's own card-ready column still requires a Vayada approval: its definition is left as
 * it is (no migration), so no reader may use that column any more
 * (onlineCardReadinessViewReaders.test.ts).
 */
export function onlineCardReadySql(readiness: string, settings: string): string {
  return `COALESCE(
    ${settings}.payment_readiness_contract_version = 'finance-payment-readiness.v1'
    AND ${settings}.payment_methods_revision IS NOT NULL
    AND ${settings}.payments_enabled
    AND ${settings}.accepted_methods @> ARRAY['card']::text[]
    AND ${readiness}.currency_eligible
    AND ${readiness}.account_scope = 'property'
    AND ${readiness}.provider_binding_active
    AND ${readiness}.provider_status = 'active'
    AND ${readiness}.provider_onboarding_status = 'completed'
    AND ${readiness}.charges_enabled
    AND ${readiness}.payouts_enabled
    AND ${readiness}.capabilities @> ARRAY['card_payments']::text[]
    AND ${readiness}.card_capability_revision > 0
    AND (
      ${readiness}.provider = 'vayada'
      OR (
        ${readiness}.provider = 'stripe'
        AND ${readiness}.details_submitted
        AND ${readiness}.card_payments_status = 'active'
      )
    ),
    FALSE
  )`;
}
