-- VAY-319: per-property Commission override note + audit log.
-- Note column lets admins record why a custom rate was negotiated.
-- commission_rate_changes captures every Commission-override edit (timestamp, admin, old, new, note)
-- so the Admin Dashboard can surface a change history per property.

ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS billing_commission_note TEXT;

-- Tighten the Commission-rate range to 0-50 (sensible upper bound for a direct-booking commission).
-- Channel-manager and affiliate ranges remain 0-100; they're separate fees.
ALTER TABLE booking_hotels
    DROP CONSTRAINT IF EXISTS booking_engine_fee_pct_range;
ALTER TABLE booking_hotels
    ADD CONSTRAINT booking_engine_fee_pct_range
    CHECK (booking_engine_fee_pct >= 0 AND booking_engine_fee_pct <= 50);

CREATE TABLE IF NOT EXISTS commission_rate_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id UUID NOT NULL REFERENCES booking_hotels(id) ON DELETE CASCADE,
    admin_user_id UUID NOT NULL,
    old_value NUMERIC(5,2) NOT NULL,
    new_value NUMERIC(5,2) NOT NULL,
    note TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS commission_rate_changes_hotel_idx
    ON commission_rate_changes(hotel_id, changed_at DESC);
