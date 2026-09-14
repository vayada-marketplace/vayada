-- VAY-1551: one canonical change request per Channex live-feed event.
-- No new request subsystem; provider identity lives on the existing request.
CREATE UNIQUE INDEX uq_booking_change_channex_event
  ON booking.booking_change_requests ((requested_changes->'channex'->>'eventId'))
  WHERE requested_changes->'channex'->>'eventId' IS NOT NULL;
