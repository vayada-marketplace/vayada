-- Per-hotel platform fee configuration and expanded fixed-plan fee fields.
-- Values align with the pricing model:
--   Fixed plan:      €30 base + €5 per extra room (1 room included)
--   Commission plan: 2% on booking-engine bookings, 3% on channel-manager (OTA) bookings
--   Affiliate:       +2% platform fee on any affiliate booking (applies under both plans)

ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS booking_engine_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 2.00,
    ADD COLUMN IF NOT EXISTS channel_manager_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 3.00,
    ADD COLUMN IF NOT EXISTS affiliate_platform_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 2.00,
    ADD COLUMN IF NOT EXISTS fixed_base_fee NUMERIC(10,2) NOT NULL DEFAULT 30.00,
    ADD COLUMN IF NOT EXISTS fixed_rooms_included INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS fixed_per_extra_room_fee NUMERIC(10,2) NOT NULL DEFAULT 5.00,
    ADD COLUMN IF NOT EXISTS billing_switch_effective_date DATE;

-- Sanity constraints on percent fields.
ALTER TABLE booking_hotels
    ADD CONSTRAINT booking_engine_fee_pct_range CHECK (booking_engine_fee_pct >= 0 AND booking_engine_fee_pct <= 100),
    ADD CONSTRAINT channel_manager_fee_pct_range CHECK (channel_manager_fee_pct >= 0 AND channel_manager_fee_pct <= 100),
    ADD CONSTRAINT affiliate_platform_fee_pct_range CHECK (affiliate_platform_fee_pct >= 0 AND affiliate_platform_fee_pct <= 100),
    ADD CONSTRAINT fixed_rooms_included_nonneg CHECK (fixed_rooms_included >= 0);
