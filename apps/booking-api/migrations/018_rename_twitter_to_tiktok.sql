DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'booking_hotels' AND column_name = 'social_twitter') THEN
    ALTER TABLE booking_hotels RENAME COLUMN social_twitter TO social_tiktok;
  END IF;
END $$;
