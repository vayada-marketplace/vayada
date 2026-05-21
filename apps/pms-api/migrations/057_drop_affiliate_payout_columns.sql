-- Drop the per-affiliate payout columns now that
-- affiliate_payout_settings (added in 056) is the canonical source and
-- every reader joins it. The settings page, super-admin payout views,
-- the scheduler payout dispatcher, and admin/affiliate response shapes
-- all source these fields via the LEFT JOIN, so dropping the columns
-- here just removes the dead duplicate.
--
-- stripe_connect_account_id and stripe_connect_onboarded stay on
-- `affiliates` because Stripe Connect onboarding is per-hotel
-- (separate audit; not part of this change).

-- The CHECK constraint references payment_method explicitly; drop it
-- first so the column drop doesn't trip RESTRICT.
ALTER TABLE affiliates DROP CONSTRAINT IF EXISTS affiliates_payment_method_check;

ALTER TABLE affiliates
    DROP COLUMN payment_method,
    DROP COLUMN paypal_email,
    DROP COLUMN bank_iban,
    DROP COLUMN bank_account_holder,
    DROP COLUMN bank_swift_bic,
    DROP COLUMN bank_name,
    DROP COLUMN bank_country,
    DROP COLUMN xendit_channel_code,
    DROP COLUMN xendit_account_number,
    DROP COLUMN xendit_account_holder_name;
