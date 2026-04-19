-- Per-rate-plan allowed payment methods on room_types.
--
-- Shape: {"flexible": ["card","pay_at_property","bank_transfer"],
--         "nonrefundable": ["card","bank_transfer"]}
-- Keys match bookings.rate_type values ("flexible" | "nonrefundable").
--
-- NULL = fall back to hotel-enabled methods (preserves pre-migration behavior).
-- Valid method values: 'card', 'pay_at_property', 'bank_transfer', 'xendit'.
-- The effective set offered to a guest is the intersection of
-- (hotel-level enabled) ∩ (this rate's allowed list).

ALTER TABLE room_types ADD COLUMN IF NOT EXISTS rate_payment_methods JSONB;
