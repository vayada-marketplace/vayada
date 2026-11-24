-- Migration: 0556_booking_switch_day_guest_emails
-- Owner: domain-booking (guest records) / VAY-2601. Held by hand: released with Flamur's yes
-- (2026-11-24) after VAY-2599's #4271, with the dry-run counts in the PR.
--
-- On 2026-11-15 (VAY-2108) Tiga's and Aether's upcoming direct bookings were copied from the old
-- system by hand. Each copy got the hotel's own email as the guest's email, so the copy wouldn't
-- email the guest, and a private note "Moved from the old system on 2026-11-15 (VAY-2108). Old
-- reference: <number>. Guest email: <email>. …" with the guest's real email. So the PMS showed the
-- hotel's address as the guest's (VAY-2601). This puts each guest's real email from that note on the
-- copy's booker and on the guest record, as a staff edit of the email does (guestProfileEdits.ts):
-- both rows change, and the booker counts as already applied, so the guest-record job leaves it.
--
-- Only a live copy (not canceled, declined or expired) whose booker still holds the hotel's address
-- changes. That address is an email another copy at the same hotel also has, on another guest
-- record: a guest whose copies staff corrected shares the corrected email only with their own record,
-- so it keeps it. A guest record changes only while it still holds the address its copies replace and
-- those copies agree on one email. The notes are only read, never changed: VAY-2599's "Find your
-- booking" reads them (old number + old email), with the same shape, window and "never edited" rule.
-- Each changed booker gets an audit row (no email in it).
-- Expected on production (dry run 2026-11-24): of the 30 copies, 28 live bookers change (Tiga 3,
-- Aether 25) and 27 guest records (one Aether guest has two copies on one record), one address per
-- hotel. More than the 30 copies made that day, or two addresses at one hotel, stops the migration,
-- and with it the next-api start (the running task keeps serving). A database without those notes
-- (tests, local, staging) is left unchanged.
-- Rollback: any image; this changes only values every image already reads. Undoing a row is a staff
-- edit back to the hotel's address.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Every guest-record writer takes this lock first (lockGuestProfiles, bookingGuestProfileLinks.ts):
-- the running task's guest-record job and staff edits wait for this migration, never in between.
SELECT pg_advisory_xact_lock(hashtext('booking.guest_profile_links'));

CREATE TEMPORARY TABLE vay2601_copies ON COMMIT DROP AS
WITH notes AS (
  SELECT note.guest_booking_id,
         note.property_id,
         substring(
           note.body FROM
           '^Moved from the old system on 2026-11-15 \(VAY-2108\)\. Old reference: \S+\. Guest email: (\S+@\S+)\. '
         ) AS email
  FROM pms.booking_notes_private note
  WHERE note.source = 'pms'
    AND note.edited_at IS NULL
    AND note.created_at >= TIMESTAMPTZ '2026-11-14 00:00:00+00'
    AND note.created_at < TIMESTAMPTZ '2026-11-17 00:00:00+00'
    AND note.body LIKE 'Moved from the old system on 2026-11-15 (VAY-2108). Old reference: %'
)
SELECT booking.id AS guest_booking_id,
       booking.property_id,
       booking.lifecycle_status,
       guest.id AS booking_guest_id,
       guest.guest_profile_id,
       guest.email AS old_email,
       min(notes.email) AS new_email,
       count(*) AS notes
FROM booking.guest_bookings booking
JOIN notes
  ON notes.guest_booking_id = booking.id
 AND notes.property_id = booking.property_id
JOIN booking.booking_guests guest
  ON guest.guest_booking_id = booking.id
 AND guest.guest_role = 'booker'
WHERE booking.source_system = 'pms'
GROUP BY booking.id, booking.property_id, booking.lifecycle_status, guest.id,
         guest.guest_profile_id, guest.email;

-- The copies to change: one note, a valid email in it, and the booker still on the hotel's address.
CREATE TEMPORARY TABLE vay2601_changes ON COMMIT DROP AS
SELECT copy.property_id, copy.booking_guest_id, copy.guest_profile_id, copy.old_email,
       btrim(copy.new_email) AS new_email
FROM vay2601_copies copy
WHERE copy.notes = 1
  AND copy.lifecycle_status NOT IN ('canceled', 'declined', 'expired')
  AND btrim(copy.new_email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  AND length(btrim(copy.new_email)) <= 254
  AND lower(btrim(copy.new_email)) IS DISTINCT FROM lower(btrim(copy.old_email))
  AND EXISTS (
    SELECT 1
    FROM vay2601_copies other
    WHERE other.property_id = copy.property_id
      AND other.guest_booking_id <> copy.guest_booking_id
      AND other.guest_profile_id IS DISTINCT FROM copy.guest_profile_id
      AND lower(btrim(other.old_email)) = lower(btrim(copy.old_email))
  );

DO $$
BEGIN
  IF (SELECT count(*) FROM vay2601_copies) > 30 THEN
    RAISE EXCEPTION 'VAY-2601: more than the 30 switch-day copies match';
  END IF;
  IF EXISTS (SELECT 1 FROM vay2601_changes GROUP BY property_id
             HAVING count(DISTINCT lower(btrim(old_email))) > 1) THEN
    RAISE EXCEPTION 'VAY-2601: the copies at one hotel hold more than one shared address';
  END IF;
END $$;

-- The guest record, while it still holds the address and its changed copies agree.
CREATE TEMPORARY TABLE vay2601_records ON COMMIT DROP AS
WITH changed AS (
  UPDATE booking.guest_profiles profile
  SET email = agreed.new_email, updated_at = now()
  FROM (
    SELECT change.guest_profile_id, min(change.new_email) AS new_email, min(change.old_email) AS old_email
    FROM vay2601_changes change
    WHERE change.guest_profile_id IS NOT NULL
    GROUP BY change.guest_profile_id
    HAVING count(DISTINCT lower(change.new_email)) = 1
       AND count(DISTINCT lower(btrim(change.old_email))) = 1
  ) agreed
  WHERE profile.id = agreed.guest_profile_id
    AND lower(btrim(profile.email)) = lower(btrim(agreed.old_email))
  RETURNING profile.id
)
SELECT id FROM changed;

-- The copy's booker, applied to its guest record already, as after a staff edit; one audit row each.
WITH changed AS (
  UPDATE booking.booking_guests guest
  SET email = change.new_email, updated_at = now(), guest_profile_synced_at = now()
  FROM vay2601_changes change
  WHERE guest.id = change.booking_guest_id
    AND guest.email IS NOT DISTINCT FROM change.old_email
  RETURNING guest.id, guest.guest_booking_id, change.property_id, change.guest_profile_id
)
INSERT INTO platform.product_audit_events (
  audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
  target_resource_product, target_resource_type, target_resource_id, correlation_id,
  redacted_payload, audit_metadata, privacy_scope
)
SELECT 'vay2601-0556:booking-guest:' || changed.id::text, 'pms',
       'pms.booking_guest.switch_day_email_restored', now(), 'property', changed.property_id,
       'migration', 'booking', 'booking_guest', changed.id::text, 'VAY-2601',
       jsonb_build_object(
         'changedFields', jsonb_build_array('email'),
         'guestBookingId', changed.guest_booking_id,
         'guestRecordChanged', COALESCE(changed.guest_profile_id IN (SELECT id FROM vay2601_records), FALSE)
       ),
       jsonb_build_object('migration', '0556', 'source', 'switch-day private note (VAY-2108)'),
       'confidential'
FROM changed;
