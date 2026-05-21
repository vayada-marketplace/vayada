ALTER TABLE room_types
ADD COLUMN IF NOT EXISTS non_refundable_rate NUMERIC(10,2);
