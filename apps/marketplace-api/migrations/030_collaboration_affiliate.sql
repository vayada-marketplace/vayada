-- Migration 030: Add affiliate tracking fields to collaborations
-- Date: 2026-03-17

ALTER TABLE collaborations
    ADD COLUMN creator_fee NUMERIC(5,2),
    ADD COLUMN affiliate_referral_code TEXT,
    ADD COLUMN affiliate_link TEXT;
