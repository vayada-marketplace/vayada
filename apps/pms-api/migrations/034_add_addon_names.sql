-- Store addon names for display in emails and booking details
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addon_names JSONB DEFAULT '[]'::jsonb;
