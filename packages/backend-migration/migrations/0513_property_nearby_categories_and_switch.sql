-- Migration: 0513_property_nearby_categories_and_switch
-- Owner: domain-hotels (curation) and domain-booking (switch) / VAY-2326
--
-- Nearby places editor v2 (VAY-2326 part G1), in Booking Admin › Location & surroundings:
-- - custom_categories: up to 8 of the host's own categories, each {id, name, color, icon}, in the host's order.
--   The API checks each one and that every own place is in one of the four categories or one of these.
-- - category_names: the host's own names for the four categories ({"food": "Street food"}). A category without
--   one keeps its translated name.
-- - nearby_places_enabled: Booking Admin's "Show nearby places" switch. It starts off for every hotel, so guests
--   see no change at release. Guests read it live, outside the booking page publication: switching it leaves
--   booking_settings.updated_at alone, like the location map switch (0509).
--
-- custom_places keeps the host's order, which guests see. Saved Google choices stay as they are: the v1 editor
-- doesn't show them, and a save that leaves them out keeps them. Both new curation columns start empty, which
-- means the four categories with their translated names.

ALTER TABLE hotel_catalog.property_nearby_curation
  ADD COLUMN custom_categories JSONB NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(custom_categories) = 'array' AND jsonb_array_length(custom_categories) <= 8),
  ADD COLUMN category_names JSONB NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(category_names) = 'object');

ALTER TABLE booking.booking_settings
  ADD COLUMN nearby_places_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN hotel_catalog.property_nearby_curation.custom_categories IS
  'The host''s own nearby categories (VAY-2326), up to 8, each {id, name, color, icon}, in the host''s order.';
COMMENT ON COLUMN hotel_catalog.property_nearby_curation.category_names IS
  'The host''s own names for the four nearby categories (VAY-2326), by key; a missing key keeps the translated name.';
COMMENT ON COLUMN booking.booking_settings.nearby_places_enabled IS
  'Booking Admin "Show nearby places" switch (VAY-2326): whether guests see the host''s nearby places.';
