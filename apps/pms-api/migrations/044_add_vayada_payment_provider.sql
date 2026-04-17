-- Add 'vayada' as a valid payment_provider option.
-- Hotels using this provider have payments processed through vayada's
-- platform Stripe account — no Stripe Connect setup needed.
ALTER TABLE hotel_payment_settings
    DROP CONSTRAINT IF EXISTS hps_payment_provider_check;

ALTER TABLE hotel_payment_settings
    ADD CONSTRAINT hps_payment_provider_check
    CHECK (payment_provider IN ('stripe', 'xendit', 'vayada'));
