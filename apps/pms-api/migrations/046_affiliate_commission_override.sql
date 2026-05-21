-- Hotel-level default affiliate commission + per-affiliate override.
-- Effective rate at booking-accept time:
--   COALESCE(affiliates.commission_pct_override, hotels.default_affiliate_commission_pct)
--
-- The legacy affiliates.commission_pct column is retained for rollback safety and
-- will be dropped in a follow-up migration once the new read path is confirmed stable.

ALTER TABLE hotels
    ADD COLUMN IF NOT EXISTS default_affiliate_commission_pct NUMERIC(5,2) NOT NULL DEFAULT 5.00;

ALTER TABLE hotels
    ADD CONSTRAINT default_affiliate_commission_pct_range
    CHECK (default_affiliate_commission_pct >= 0 AND default_affiliate_commission_pct <= 100);

ALTER TABLE affiliates
    ADD COLUMN IF NOT EXISTS commission_pct_override NUMERIC(5,2);

ALTER TABLE affiliates
    ADD CONSTRAINT commission_pct_override_range
    CHECK (commission_pct_override IS NULL OR (commission_pct_override >= 0 AND commission_pct_override <= 100));

-- Backfill: any existing affiliate whose commission diverges from the new default
-- becomes an explicit override so behavior is preserved for every live booking relationship.
UPDATE affiliates
   SET commission_pct_override = commission_pct
 WHERE commission_pct IS DISTINCT FROM 5.00;
