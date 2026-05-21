-- VAY-319: standardize the Commission plan rate at 5% (was 2%).
-- The hotel-facing Billing card now shows a single "Direct bookings: 5%" row.
-- Existing hotels still on the old 2.00 default move to 5.00; admin-set values are left alone.

ALTER TABLE booking_hotels
    ALTER COLUMN booking_engine_fee_pct SET DEFAULT 5.00;

UPDATE booking_hotels
SET booking_engine_fee_pct = 5.00
WHERE booking_engine_fee_pct = 2.00;
