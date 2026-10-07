-- Supplier-bill document references remain immutable evidence on each ledger row.
-- A correction may carry the corrected reference while the reversed row retains history.
ALTER TABLE finance.expenses DROP CONSTRAINT chk_finance_expenses_origin_evidence;
ALTER TABLE finance.expenses ADD CONSTRAINT chk_finance_expenses_origin_evidence CHECK (
  (entry_kind <> 'expense' AND recurring_rule_id IS NULL AND guest_booking_id IS NULL
    AND payment_id IS NULL AND (supplier_invoice_number IS NULL OR
      (origin = 'supplier_bill' AND entry_kind = 'correction')))
  OR (entry_kind = 'expense' AND (
    (origin = 'manual' AND recurring_rule_id IS NULL AND guest_booking_id IS NULL
      AND payment_id IS NULL AND supplier_invoice_number IS NULL)
    OR (origin = 'recurring' AND recurring_rule_id IS NOT NULL AND guest_booking_id IS NULL
      AND payment_id IS NULL AND supplier_invoice_number IS NULL)
    OR (origin = 'ota_commission' AND recurring_rule_id IS NULL AND guest_booking_id IS NOT NULL
      AND payment_id IS NULL AND supplier_invoice_number IS NULL)
    OR (origin = 'platform_fee' AND recurring_rule_id IS NULL AND guest_booking_id IS NULL
      AND payment_id IS NOT NULL AND supplier_invoice_number IS NULL)
    OR (origin = 'supplier_bill' AND recurring_rule_id IS NULL AND guest_booking_id IS NULL
      AND payment_id IS NULL)
  ))
);
