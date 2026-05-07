-- VAY-388: Soft-hold table used during the card-payment window so we
-- don't insert a real booking row (and block inventory for 24h) before
-- the guest has actually entered their card details.
--
-- A draft is created at the moment the guest clicks "Continue to Payment",
-- expires after ~15 minutes, and is materialized into a real bookings row
-- by the Stripe webhook (or the synchronous confirm-authorization endpoint)
-- once the PaymentIntent succeeds.

CREATE TABLE IF NOT EXISTS booking_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    number_of_rooms INT NOT NULL DEFAULT 1,
    booking_reference VARCHAR(20) NOT NULL UNIQUE,
    stripe_payment_intent_id VARCHAR(255) NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_drafts_room_type_dates
    ON booking_drafts (room_type_id, check_in, check_out);

CREATE INDEX IF NOT EXISTS idx_booking_drafts_expires_at
    ON booking_drafts (expires_at);
