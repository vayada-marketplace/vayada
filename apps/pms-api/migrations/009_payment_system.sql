-- Migration 009: Payment system tables
-- Adds Stripe payment integration, host approval flow, cancellation policies, and payouts

-- Hotel payment settings (Stripe Connect, fee configuration)
CREATE TABLE hotel_payment_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL UNIQUE REFERENCES hotels(id) ON DELETE CASCADE,
    stripe_connect_account_id TEXT,
    stripe_connect_onboarded BOOLEAN NOT NULL DEFAULT false,
    platform_fee_type TEXT NOT NULL DEFAULT 'percentage'
        CHECK (platform_fee_type IN ('flat', 'percentage')),
    platform_fee_value NUMERIC(10,2) NOT NULL DEFAULT 8.00,
    platform_fee_with_affiliate NUMERIC(10,2) NOT NULL DEFAULT 2.00,
    pay_at_property_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cancellation policies per hotel
CREATE TABLE cancellation_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL UNIQUE REFERENCES hotels(id) ON DELETE CASCADE,
    free_cancellation_days INTEGER NOT NULL DEFAULT 7,
    partial_refund_pct NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Payment records linked to bookings
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    stripe_payment_intent_id TEXT UNIQUE,
    amount NUMERIC(10,2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'requires_action', 'authorized', 'captured',
                          'cancelled', 'refunded', 'partially_refunded', 'failed')),
    payment_method TEXT NOT NULL DEFAULT 'card'
        CHECK (payment_method IN ('card', 'pay_at_property')),
    card_last_four TEXT,
    card_brand TEXT,
    captured_at TIMESTAMPTZ,
    refunded_at TIMESTAMPTZ,
    refund_amount NUMERIC(10,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_booking_id ON payments(booking_id);
CREATE INDEX idx_payments_stripe_pi ON payments(stripe_payment_intent_id);

-- Payout records for hotels and affiliates
CREATE TABLE payouts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('hotel', 'affiliate')),
    recipient_id UUID NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'processing', 'completed', 'failed')),
    stripe_transfer_id TEXT,
    scheduled_for TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payouts_booking_id ON payouts(booking_id);
CREATE INDEX idx_payouts_status ON payouts(status);
CREATE INDEX idx_payouts_scheduled ON payouts(scheduled_for);

-- Extend bookings table with payment fields
ALTER TABLE bookings
    ADD COLUMN payment_method TEXT DEFAULT 'card'
        CHECK (payment_method IN ('card', 'pay_at_property')),
    ADD COLUMN payment_status TEXT DEFAULT 'unpaid'
        CHECK (payment_status IN ('unpaid', 'authorized', 'captured', 'cancelled',
                                  'refunded', 'partially_refunded', 'failed', 'pay_at_property')),
    ADD COLUMN host_response_deadline TIMESTAMPTZ,
    ADD COLUMN platform_fee_amount NUMERIC(10,2),
    ADD COLUMN affiliate_commission_amount NUMERIC(10,2),
    ADD COLUMN property_payout_amount NUMERIC(10,2),
    ADD COLUMN guest_withdrawn BOOLEAN NOT NULL DEFAULT false;

-- Add 'expired' to booking status constraint
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired'));
