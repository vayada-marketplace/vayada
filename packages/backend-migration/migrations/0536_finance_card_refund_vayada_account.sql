-- VAY-2442 P4. A refund of a vayada Payment charge runs on Vayada's own Stripe account. Its command
-- keeps the payment's vayada:<property> reference, which the payment provider routes there; a
-- Stripe Connect refund keeps its acct_ reference as before.
SET LOCAL lock_timeout = '5s';

ALTER TABLE finance.card_refund_commands
  DROP CONSTRAINT card_refund_commands_provider_account_ref_check,
  ADD CONSTRAINT card_refund_commands_provider_account_ref_check CHECK (
    provider_account_ref LIKE 'acct\_%'
    OR provider_account_ref ~ '^vayada:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
