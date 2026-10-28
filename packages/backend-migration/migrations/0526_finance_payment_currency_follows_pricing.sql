-- VAY-2390 P5: a protected pricing currency change carries Finance's bound payment currency with it.
-- 0055 bound finance.payment_settings to the pricing row's (property, currency, revision) with no
-- update action, so once Finance was bound the pricing currency could never change. ON UPDATE
-- CASCADE moves the bound Finance row in the same statement. Every other reference to the pricing
-- row (0050 rate plans, 0052 recurring sources, 0067 recurring expense rules, 0070 expenses,
-- 0071 folio revisions) stays as it is: the change command refuses with a named blocker first.
SET LOCAL lock_timeout = '5s';

ALTER TABLE finance.payment_settings
  DROP CONSTRAINT fk_finance_payment_settings_pricing_currency_revision,
  ADD CONSTRAINT fk_finance_payment_settings_pricing_currency_revision
    FOREIGN KEY (property_id, default_currency, source_pricing_currency_revision)
    REFERENCES pms.property_pricing_settings (
      property_id, currency, pricing_currency_revision
    )
    ON UPDATE CASCADE;
