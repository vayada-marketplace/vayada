-- Add 'affiliate' to the allowed user types
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_type_check;
ALTER TABLE users ADD CONSTRAINT users_type_check
  CHECK (type = ANY (ARRAY['hotel'::text, 'creator'::text, 'admin'::text, 'affiliate'::text]));
