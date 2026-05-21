ALTER TABLE booking_hotels
ADD COLUMN IF NOT EXISTS booking_filters JSONB DEFAULT '[]'::jsonb;

UPDATE booking_hotels SET booking_filters = '[]'::jsonb
WHERE booking_filters IS DISTINCT FROM '[]'::jsonb;
