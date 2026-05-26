-- VAY-516: Add gender, date_of_birth, and passport_number to the bookings
-- table so the booker (primary guest) can carry the same demographic fields
-- as additional guests.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS guest_gender TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS guest_date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS guest_passport_number TEXT NOT NULL DEFAULT '';
