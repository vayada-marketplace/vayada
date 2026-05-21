-- Phase 7 cleanup: remove the pre-override flat commission column.
-- All reads now use COALESCE(commission_pct_override, hotels.default_affiliate_commission_pct).
-- Backfill from migration 046 moved any diverging values into commission_pct_override,
-- so this drop is safe.

ALTER TABLE affiliates DROP COLUMN IF EXISTS commission_pct;
