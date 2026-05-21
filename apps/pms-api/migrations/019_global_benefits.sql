-- Move benefits from room_types to hotels (global, hotel-level)
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS benefits JSONB NOT NULL DEFAULT '[]';

-- Migrate: copy benefits from the first room type that has benefits to the hotel
UPDATE hotels h SET benefits = rt.benefits
FROM (
  SELECT DISTINCT ON (hotel_id) hotel_id, benefits
  FROM room_types
  WHERE benefits != '[]'::jsonb
  ORDER BY hotel_id, created_at
) rt
WHERE h.id = rt.hotel_id;
