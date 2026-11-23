-- Migration: 0551_booking_host_notification_done
-- Owner: domain-booking (notifications bell) / VAY-2591
--
-- "Mark as done" on a bell notification that needs action: a missed bank transfer or a promo code that is
-- ending or used up. Done counts for the whole team of the property, unlike read marks (0514), which are
-- each person's own. A done item leaves the "Needs action" tab and shows as read in "All" for everyone.
-- The failing channel sync card can't be marked done: it clears itself once the sync works again.
--
-- notification_key uses the same names as booking.host_notification_reads. The API deletes a property's
-- done marks older than 60 days when someone marks something done (the bell lists 30 days). done_by
-- clears with the user. An ordinary product table: the runtime login gets its DML from the schema's
-- default privileges.
SET LOCAL lock_timeout = '5s';

CREATE TABLE booking.host_notification_done (
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  notification_key TEXT NOT NULL CHECK (notification_key ~ '^[a-z][a-z-]*:[A-Za-z0-9:._-]{1,200}$'),
  done_by UUID REFERENCES identity.users(id) ON DELETE SET NULL,
  done_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, notification_key)
);

CREATE INDEX idx_host_notification_done_property_done_at
  ON booking.host_notification_done (property_id, done_at);

COMMENT ON TABLE booking.host_notification_done IS
  'VAY-2591: bell notifications a property''s team marked done. Marks older than 60 days are deleted.';
