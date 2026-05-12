-- VAY-394: track historical slugs so a property rename can repoint the
-- canonical slug without breaking links shared on the old subdomain.
--
-- When admin/settings rewrites the slug on a hotel rename, the previous
-- value is appended here. GET /api/hotels/{slug} consults this array on
-- miss and responds with a 301 to the canonical, so the storefront can
-- redirect the browser to the new subdomain.

ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS previous_slugs TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS booking_hotels_previous_slugs_idx
    ON booking_hotels USING GIN (previous_slugs);
