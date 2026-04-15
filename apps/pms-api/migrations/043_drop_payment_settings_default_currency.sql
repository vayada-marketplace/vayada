-- Drop hotel_payment_settings.default_currency.
-- Currency is owned by booking_db.booking_hotels.currency (single source
-- of truth). This column was left dead by the Stage 1 refactor and is
-- now removed. IF EXISTS makes the migration idempotent so it's safe
-- to re-run after the prod column has already been dropped manually.
ALTER TABLE hotel_payment_settings DROP COLUMN IF EXISTS default_currency;
