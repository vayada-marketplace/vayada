ALTER TABLE booking_hotels
  ADD COLUMN IF NOT EXISTS paypal_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paypal_email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS paypal_payment_window_hours INTEGER NOT NULL DEFAULT 24;

ALTER TABLE booking_hotels
  DROP CONSTRAINT IF EXISTS booking_hotels_paypal_window_hours_chk;
ALTER TABLE booking_hotels
  ADD CONSTRAINT booking_hotels_paypal_window_hours_chk
  CHECK (paypal_payment_window_hours BETWEEN 1 AND 168);

ALTER TABLE booking_hotels
  DROP CONSTRAINT IF EXISTS booking_hotels_paypal_email_required_chk;
ALTER TABLE booking_hotels
  ADD CONSTRAINT booking_hotels_paypal_email_required_chk
  CHECK (NOT paypal_enabled OR length(btrim(paypal_email)) > 0);
