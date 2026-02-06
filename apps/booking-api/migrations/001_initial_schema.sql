-- Vayada Booking Engine - Initial Schema
-- Creates the booking_hotels table for hotel configuration/display data

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS booking_hotels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    star_rating INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'EUR',
    hero_image TEXT NOT NULL DEFAULT '',
    images JSONB NOT NULL DEFAULT '[]'::jsonb,
    amenities JSONB NOT NULL DEFAULT '[]'::jsonb,
    check_in_time TEXT NOT NULL DEFAULT '15:00',
    check_out_time TEXT NOT NULL DEFAULT '11:00',

    -- Contact
    contact_address TEXT NOT NULL DEFAULT '',
    contact_phone TEXT NOT NULL DEFAULT '',
    contact_email TEXT NOT NULL DEFAULT '',
    contact_whatsapp TEXT,

    -- Social Links
    social_facebook TEXT,
    social_instagram TEXT,
    social_twitter TEXT,
    social_youtube TEXT,

    -- Branding
    branding_primary_color TEXT,
    branding_logo_url TEXT,
    branding_favicon_url TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_hotels_slug ON booking_hotels (slug);
