-- Migration 077: booking_additional_guests — the non-booker guests on a
-- reservation (VAY-495 booking-detail card #4).
--
-- The booker (lead guest) lives on the bookings row itself
-- (guest_first_name, guest_last_name, guest_email, guest_phone,
-- guest_country). Additional guests are the rest of the party, captured
-- here so the hotel has check-in details for everyone — required by law in
-- many jurisdictions (passport / ID number, date of birth, nationality).
--
-- Position is the display ordinal (1..N) inside the booking — distinct
-- from booking_rooms.position, which is about physical rooms.
-- Whether a guest is assigned to a specific room is deliberately left
-- out of v1 (open question on the ticket — multi-room per-guest assignment
-- needs a separate UX pass).

CREATE TABLE IF NOT EXISTS booking_additional_guests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    hotel_id UUID NOT NULL,
    position INTEGER NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    gender TEXT NOT NULL DEFAULT '',
    nationality TEXT NOT NULL DEFAULT '',
    date_of_birth DATE,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    passport_number TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_additional_guests_booking_id
    ON booking_additional_guests(booking_id, position);
CREATE INDEX IF NOT EXISTS idx_booking_additional_guests_hotel_id
    ON booking_additional_guests(hotel_id);
