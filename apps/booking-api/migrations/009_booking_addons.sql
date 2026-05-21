-- Addons table
CREATE TABLE IF NOT EXISTS booking_addons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id UUID NOT NULL REFERENCES booking_hotels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price NUMERIC(10,2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'EUR',
    category TEXT NOT NULL DEFAULT 'experience',
    image TEXT NOT NULL DEFAULT '',
    duration TEXT,
    per_person BOOLEAN DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_addons_hotel_id ON booking_addons(hotel_id);

-- Hotel-level addon display settings
ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS show_addons_step BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS group_addons_by_category BOOLEAN NOT NULL DEFAULT true;
