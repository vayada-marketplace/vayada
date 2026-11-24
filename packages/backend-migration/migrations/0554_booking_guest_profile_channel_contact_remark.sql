-- Migration: 0554_booking_guest_profile_channel_contact_remark
-- Owner: domain-booking (guest records) / VAY-2577
--
-- VAY-2577 (#4220) shows a channel booking's guest contact: the PMS used to hide it until an acceptance
-- that a channel booking never gets. The guest-record job (apps/api/src/jobs/bookingGuestProfileLinks.ts)
-- copies contact that becomes visible onto the guest record, but not for a booking that had already
-- closed (canceled, completed, no-show, declined) while its contact was hidden: such a row was saved as
-- not deferred, so the job never reads it again. This marks those rows once, so the job's next run fills
-- the guest record's empty email or phone (a channel booking never replaces a value there).
--
-- Only rows whose guest record lacks a value the stay has are marked, so a second run marks nothing.
-- Left out: a row holding a Channex mask ("***", stored before #4220), which the job would copy; a row
-- whose name differs from its guest record's, since re-reading it would let the job rename that record
-- (undoing a staff rename) or merge it away; and expired bookings, which the job never reads.
-- updated_at is left alone: the row itself didn't change. Dry run on production 2026-11-23: 4 closed channel stays, all canceled (Tiga 1,
-- Aether 3). The job's code must be #4220's or later (live since 2026-11-23 17:39Z): an older job would
-- clear the mark without filling anything.
SET LOCAL lock_timeout = '5s';

UPDATE booking.booking_guests guest
SET guest_profile_contact_deferred = TRUE
FROM booking.guest_bookings booking, booking.guest_profiles profile
WHERE booking.id = guest.guest_booking_id
  AND profile.id = guest.guest_profile_id
  AND NOT guest.guest_profile_contact_deferred
  AND booking.lifecycle_status IN ('declined', 'canceled', 'completed', 'no_show')
  AND EXISTS (
    SELECT 1
    FROM pms.channel_booking_mappings mapping
    WHERE mapping.guest_booking_id = booking.id
      AND mapping.property_id = booking.property_id
  )
  AND profile.name_key = lower(regexp_replace(btrim(guest.first_name || ' ' || guest.last_name), '\s+', ' ', 'g'))
  AND btrim(COALESCE(guest.email, '')) !~ '^[*]+$'
  AND btrim(COALESCE(guest.phone, '')) !~ '^[*]+$'
  AND (
    (profile.email IS NULL AND btrim(COALESCE(guest.email, '')) <> '')
    OR (profile.phone IS NULL AND btrim(COALESCE(guest.phone, '')) <> '')
  );
