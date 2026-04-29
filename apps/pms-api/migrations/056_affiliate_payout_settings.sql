-- Single canonical row of payout settings per affiliate user.
--
-- Until now payout fields lived on `affiliates` (one row per
-- hotel-affiliate combo), and PATCH /affiliate/me looped over every
-- row for the user updating each in turn. Same data, multiple rows,
-- silent drift if any per-row edit happened out of band.
--
-- This table holds the canonical settings per user_id. The PATCH
-- endpoint will mirror writes back to `affiliates` so the existing
-- payout service (which reads payment_method etc. from the affiliate
-- row at payout time) keeps working without changes — a follow-up
-- migration can drop those columns once the payout path migrates.

CREATE TABLE affiliate_payout_settings (
    user_id UUID PRIMARY KEY,
    payment_method TEXT NOT NULL DEFAULT 'stripe'
        CHECK (payment_method IN ('paypal', 'bank', 'stripe', 'xendit')),
    paypal_email TEXT NOT NULL DEFAULT '',
    bank_iban TEXT NOT NULL DEFAULT '',
    bank_account_holder TEXT NOT NULL DEFAULT '',
    bank_swift_bic TEXT NOT NULL DEFAULT '',
    bank_name TEXT NOT NULL DEFAULT '',
    bank_country TEXT NOT NULL DEFAULT '',
    xendit_channel_code TEXT,
    xendit_account_number TEXT,
    xendit_account_holder_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill: pick the most-recently-updated affiliate row per user_id.
-- DISTINCT ON in combination with an ORDER BY user_id, updated_at DESC
-- gives us exactly that.
INSERT INTO affiliate_payout_settings (
    user_id, payment_method, paypal_email,
    bank_iban, bank_account_holder, bank_swift_bic, bank_name, bank_country,
    xendit_channel_code, xendit_account_number, xendit_account_holder_name,
    created_at, updated_at
)
SELECT DISTINCT ON (user_id)
    user_id,
    payment_method,
    COALESCE(paypal_email, ''),
    COALESCE(bank_iban, ''),
    COALESCE(bank_account_holder, ''),
    COALESCE(bank_swift_bic, ''),
    COALESCE(bank_name, ''),
    COALESCE(bank_country, ''),
    xendit_channel_code,
    xendit_account_number,
    xendit_account_holder_name,
    created_at,
    updated_at
FROM affiliates
WHERE user_id IS NOT NULL
ORDER BY user_id, updated_at DESC;
