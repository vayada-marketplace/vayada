ALTER TABLE hotels ADD COLUMN IF NOT EXISTS calendar_auto_open_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS calendar_auto_open_mode TEXT NOT NULL DEFAULT 'rolling';
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS calendar_auto_open_months INTEGER NOT NULL DEFAULT 18;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS calendar_auto_open_fixed_month DATE;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS calendar_auto_open_through DATE;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS calendar_auto_open_last_run_at TIMESTAMPTZ;

ALTER TABLE hotels DROP CONSTRAINT IF EXISTS hotels_calendar_auto_open_mode_check;
ALTER TABLE hotels ADD CONSTRAINT hotels_calendar_auto_open_mode_check
    CHECK (calendar_auto_open_mode IN ('rolling', 'fixed'));

ALTER TABLE hotels DROP CONSTRAINT IF EXISTS hotels_calendar_auto_open_months_check;
ALTER TABLE hotels ADD CONSTRAINT hotels_calendar_auto_open_months_check
    CHECK (calendar_auto_open_months IN (12, 18, 24));
