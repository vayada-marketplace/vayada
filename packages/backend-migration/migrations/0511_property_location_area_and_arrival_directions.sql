-- Migration: 0511_property_location_area_and_arrival_directions
-- Owner: domain-hotels / VAY-2322
--
-- Two optional parts of a property's address, edited in the PMS "Property address" modal and Booking
-- Admin's Location settings (VAY-2322 part F2): the area or village, which Google's address search often
-- leaves out in Sri Lanka and Bali, and arrival directions for guests, sent in the booking confirmation
-- email (part F3). Both start empty for every property, so nothing changes for guests at release.
--
-- Plain nullable columns: the API checks their lengths (120 and 1000 characters). No CHECK, policy or
-- trigger change on this table, and neither moves the location's owner revision (0060 tracks the pin,
-- address and visibility).

ALTER TABLE hotel_catalog.property_locations
  ADD COLUMN area TEXT,
  ADD COLUMN arrival_directions TEXT;

COMMENT ON COLUMN hotel_catalog.property_locations.area IS
  'Area or village of the property''s address (VAY-2322), shown with the street. NULL when not given.';
COMMENT ON COLUMN hotel_catalog.property_locations.arrival_directions IS
  'How guests find the entrance (VAY-2322), sent in the booking confirmation email. NULL when not given.';
