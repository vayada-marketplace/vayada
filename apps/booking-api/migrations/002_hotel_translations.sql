-- Vayada Booking Engine - Hotel Translations
-- Stores translated hotel content per locale (fallback to English in base table)

CREATE TABLE IF NOT EXISTS booking_hotel_translations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES booking_hotels(id) ON DELETE CASCADE,
    locale TEXT NOT NULL,
    name TEXT,
    description TEXT,
    location TEXT,
    country TEXT,
    contact_address TEXT,
    amenities JSONB,
    UNIQUE(hotel_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_booking_hotel_translations_hotel_locale
    ON booking_hotel_translations (hotel_id, locale);
