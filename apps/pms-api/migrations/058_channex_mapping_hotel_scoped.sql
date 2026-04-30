-- Migration 058: scope Channex mapping uniqueness by hotel + enforce
-- booking/room_type hotel consistency.
--
-- Without these, a single channex_room_type_id or channex_booking_id could
-- only exist once across the entire platform, and lookups by those IDs
-- ignored hotel_id — letting one hotel's polling loop resolve another
-- hotel's mapping when property_id filtering failed.
--
-- The trigger guarantees that a booking's hotel_id matches the hotel that
-- owns its room_type. This was previously enforced only in application code,
-- and the Channex import path bypassed it.

DROP INDEX IF EXISTS idx_channex_room_mappings_channex;
CREATE UNIQUE INDEX idx_channex_room_mappings_hotel_channex
    ON channex_room_type_mappings(hotel_id, channex_room_type_id);

DROP INDEX IF EXISTS idx_channex_booking_mappings_channex;
CREATE UNIQUE INDEX idx_channex_booking_mappings_hotel_channex
    ON channex_booking_mappings(hotel_id, channex_booking_id);

DROP INDEX IF EXISTS idx_channex_rate_plan_mappings_channex;
CREATE UNIQUE INDEX idx_channex_rate_plan_mappings_hotel_channex
    ON channex_rate_plan_mappings(hotel_id, channex_rate_plan_id);


CREATE OR REPLACE FUNCTION enforce_booking_hotel_matches_room_type()
RETURNS TRIGGER AS $$
DECLARE
    rt_hotel_id UUID;
BEGIN
    SELECT hotel_id INTO rt_hotel_id
    FROM room_types
    WHERE id = NEW.room_type_id;

    IF rt_hotel_id IS NOT NULL AND rt_hotel_id != NEW.hotel_id THEN
        RAISE EXCEPTION
            'bookings.hotel_id (%) does not match room_types.hotel_id (%) for room_type %',
            NEW.hotel_id, rt_hotel_id, NEW.room_type_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_hotel_matches_room_type ON bookings;
CREATE TRIGGER trg_booking_hotel_matches_room_type
    BEFORE INSERT OR UPDATE OF hotel_id, room_type_id ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION enforce_booking_hotel_matches_room_type();
