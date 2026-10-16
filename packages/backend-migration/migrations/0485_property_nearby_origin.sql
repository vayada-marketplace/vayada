-- Migration: 0485_property_nearby_origin
-- Owner: domain-hotels / VAY-2104
--
-- Nearby picks and Google suggestions follow the hotel's public map pin, not every profile save.
-- Before this, a phone-number-only Property save hid the hotel's favorites, notes and own places
-- and made the next view pay for a new Google lookup.
-- - Each column holds a sha256 of the public search origin (the point guests see: exact, or
--   rounded to 2 decimals for an approximate map) at save or lookup time. It is not secret
--   (property_locations keeps the coordinates) and no API returns it.
-- - A row stays current while the hash matches today's point, so on an approximate map a move
--   inside the same rounded cell keeps picks and the lookup. NULL (older rows) keeps the old
--   rule: current only at the same profile revision.

ALTER TABLE hotel_catalog.property_nearby_curation ADD COLUMN saved_origin TEXT;
ALTER TABLE hotel_catalog.property_nearby_discovery ADD COLUMN origin TEXT;

COMMENT ON COLUMN hotel_catalog.property_nearby_curation.saved_origin IS
  'VAY-2104: sha256 of the public search origin when the picks were saved.';
COMMENT ON COLUMN hotel_catalog.property_nearby_discovery.origin IS
  'VAY-2104: sha256 of the public search origin the lookup used.';
