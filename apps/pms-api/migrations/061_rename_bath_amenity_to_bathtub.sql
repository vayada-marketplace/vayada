-- Migration 061: rename "Bath" amenity to "Bathtub" on existing rooms.
--
-- The Bathroom amenity label changed from "Bath" to "Bathtub" (VAY-129)
-- to disambiguate from the bathroom itself. Rewrite stored amenity arrays
-- so existing room types keep the checkbox checked after the rename.

UPDATE room_types
SET amenities = (
    SELECT jsonb_agg(
        CASE WHEN elem = '"Bath"'::jsonb THEN '"Bathtub"'::jsonb ELSE elem END
    )
    FROM jsonb_array_elements(amenities) AS elem
)
WHERE amenities @> '["Bath"]'::jsonb;
