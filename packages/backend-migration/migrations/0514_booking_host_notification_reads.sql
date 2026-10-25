-- Migration: 0514_booking_host_notification_reads
-- Owner: domain-booking (Booking Admin notifications bell) / VAY-2349
--
-- Booking Admin's bell lists the selected property's last 30 days: new, modified and cancelled booking-page
-- bookings, missed bank transfers, a failing channel manager sync, ending or used-up promo codes and team members
-- who joined. The API builds that list from the rows that already record those things (booking status events,
-- channel sync status, promo codes, team memberships), so nothing is copied.
--
-- This table only remembers what each person has read, per property, so "mark as read" and "Mark all read" hold
-- across sessions and devices. notification_key names one notification, e.g. "booking-event:<status event id>" or
-- "promo-ending:<promo id>:<end date>". The API deletes a person's marks older than 60 days when they mark
-- something read. An ordinary product table: the runtime login gets its DML from the schema's default privileges.
SET LOCAL lock_timeout = '5s';

CREATE TABLE booking.host_notification_reads (
  user_id UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  notification_key TEXT NOT NULL CHECK (notification_key ~ '^[a-z][a-z-]*:[A-Za-z0-9:._-]{1,200}$'),
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, property_id, notification_key)
);

CREATE INDEX idx_host_notification_reads_user_read_at
  ON booking.host_notification_reads (user_id, read_at);

-- The bell reads a property's bookings changed in the last 30 days every minute per open tab: every
-- booking status event writer also bumps updated_at, so this index keeps that read to the recent bookings.
CREATE INDEX idx_guest_bookings_property_updated_at
  ON booking.guest_bookings (property_id, updated_at);

COMMENT ON TABLE booking.host_notification_reads IS
  'VAY-2349: which Booking Admin bell notifications a person has read, per property. Marks older than 60 days are deleted.';
