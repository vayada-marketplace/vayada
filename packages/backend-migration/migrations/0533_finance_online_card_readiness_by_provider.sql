-- VAY-2442 P2. Card readiness per provider. finance.online_card_readiness (0119, 0408) stays exactly
-- as it is: the Channex worker attests its definition in its catalog digest, so changing it would
-- need a re-pinned image released first. This view passes every row and column of it through and
-- adds vayada Payment: Vayada's own Stripe account, bound as vayada:<property> once the hotel saved
-- its payout account (payouts on, 0531), and Vayada's card approval for the current revisions.
-- For every other provider, provider_binding_active and online_card_ready are the old values.
CREATE VIEW finance.online_card_readiness_by_provider WITH (security_invoker = true) AS
SELECT
  readiness.property_id,
  readiness.provider_account_id,
  readiness.provider,
  readiness.account_scope,
  CASE
    WHEN readiness.provider = 'vayada'
      THEN COALESCE(account.provider_account_id = 'vayada:' || readiness.property_id::text, FALSE)
    ELSE readiness.provider_binding_active
  END AS provider_binding_active,
  readiness.provider_status,
  readiness.provider_onboarding_status,
  readiness.charges_enabled,
  readiness.payouts_enabled,
  readiness.details_submitted,
  readiness.card_payments_status,
  readiness.capabilities,
  readiness.card_capability_revision,
  readiness.property_readiness_revision,
  readiness.currency_eligible,
  readiness.execution_evidence_id,
  readiness.execution_evidence_contract_version,
  readiness.execution_evidence_provider_account_id,
  readiness.execution_evidence_capability_revision,
  readiness.execution_evidence_property_readiness_revision,
  readiness.execution_evidence_accepted_at,
  readiness.execution_evidence_revoked_at,
  readiness.online_card_ready OR COALESCE(
    readiness.provider = 'vayada'
      AND account.provider_account_id = 'vayada:' || readiness.property_id::text
      AND settings.payment_readiness_contract_version = 'finance-payment-readiness.v1'
      AND settings.payment_methods_revision IS NOT NULL
      AND settings.payments_enabled
      AND 'card' = ANY(settings.accepted_methods)
      AND readiness.currency_eligible
      AND readiness.account_scope = 'property'
      AND readiness.provider_status = 'active'
      AND readiness.provider_onboarding_status = 'completed'
      AND readiness.charges_enabled
      AND readiness.payouts_enabled
      AND readiness.capabilities @> ARRAY['card_payments']::TEXT[]
      AND readiness.card_capability_revision > 0
      AND readiness.execution_evidence_contract_version = 'finance-online-card-execution-evidence.v1'
      AND readiness.execution_evidence_capability_revision = readiness.card_capability_revision
      AND readiness.execution_evidence_property_readiness_revision
        = readiness.property_readiness_revision
      AND readiness.execution_evidence_revoked_at IS NULL,
    FALSE
  ) AS online_card_ready
FROM finance.online_card_readiness readiness
JOIN finance.payment_settings settings
  ON settings.property_id = readiness.property_id
LEFT JOIN finance.payment_provider_accounts account
  ON account.id = readiness.provider_account_id
 AND account.property_id = readiness.property_id;
