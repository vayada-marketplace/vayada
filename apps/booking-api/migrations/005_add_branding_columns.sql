ALTER TABLE booking_hotels
  ADD COLUMN IF NOT EXISTS branding_accent_color TEXT,
  ADD COLUMN IF NOT EXISTS branding_font_pairing TEXT;
