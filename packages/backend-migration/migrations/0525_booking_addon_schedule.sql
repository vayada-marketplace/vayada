-- Migration: 0525_booking_addon_schedule
-- Owner: domain-booking / VAY-2391
--
-- "When does it happen?" for each add-on (Booking Admin › Add-ons):
-- - arrival: on the check-in day;
-- - departure: on the check-out day;
-- - guest_pick: the guest picks a day, on the bookable weekdays only;
-- - daily: every night of the stay;
-- - anytime: no day.
-- Only guest_pick asks the guest. The booked line keeps the day in the existing
-- booking.booking_addon_selections.service_date: one row per night for daily, none (NULL) for anytime.
--
-- A per-night price always means daily, and daily always has a per-night price (Flamur, 2026-10-28). The API keeps
-- the two together. There is no CHECK for it: older writers and the legacy import set only the price, and readers
-- treat a per-night price as daily anyway.
--
-- Existing add-ons keep what they do today (approved 2026-10-28; 2 add-ons in production):
-- - per-night prices become daily;
-- - one-off transport becomes arrival;
-- - everything else is guest_pick on every weekday.
--
-- Weekdays are ISO numbers: 1 is Monday, 7 is Sunday.
SET LOCAL lock_timeout = '5s';

ALTER TABLE booking.addon_definitions
  ADD COLUMN schedule_mode TEXT NOT NULL DEFAULT 'guest_pick'
    CONSTRAINT chk_addon_definitions_schedule_mode
      CHECK (schedule_mode IN ('arrival', 'departure', 'guest_pick', 'daily', 'anytime')),
  ADD COLUMN bookable_weekdays SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}'
    CONSTRAINT chk_addon_definitions_bookable_weekdays
      CHECK (array_ndims(bookable_weekdays) = 1
        AND cardinality(bookable_weekdays) BETWEEN 1 AND 7
        AND bookable_weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]);

UPDATE booking.addon_definitions
SET schedule_mode = 'daily'
WHERE pricing_model IN ('per_night', 'per_guest_night');

UPDATE booking.addon_definitions
SET schedule_mode = 'arrival'
WHERE pricing_model IN ('per_stay', 'per_guest')
  AND lower(btrim(category)) = 'transport';

COMMENT ON COLUMN booking.addon_definitions.schedule_mode IS
  'VAY-2391: when the add-on happens (arrival, departure, guest_pick, daily or anytime). Per-night prices are daily.';
COMMENT ON COLUMN booking.addon_definitions.bookable_weekdays IS
  'VAY-2391: ISO weekdays (1 Monday … 7 Sunday) a guest can pick for a guest_pick add-on.';
