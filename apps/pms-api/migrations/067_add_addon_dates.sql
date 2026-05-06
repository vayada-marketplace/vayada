-- Migration 067: Per-day add-ons can have specific dates selected by the guest (VAY-360)
--
-- For add-ons charged per day (perNight=true), the guest may now pick which
-- nights of the stay the add-on applies to. We persist the selected ISO dates
-- per addon in a new JSONB column. An empty list (or missing key) means "all
-- nights of the stay" — preserving prior behaviour for bookings created before
-- this column existed.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addon_dates JSONB NOT NULL DEFAULT '{}'::jsonb;
