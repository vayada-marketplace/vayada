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
-- changes: an email that another copy at the same hotel also has. A copy staff already corrected
-- keeps its email. A guest record changes only while it still holds that address and its copies
-- agree on one email. The notes are only read, never changed: VAY-2599's "Find your booking" reads
-- them (old number + old email), with the same shape, window and "never edited" rule as here.
-- Expected on production (dry run 2026-11-24): 28 copies (Tiga 3, Aether 25). More than the 30
-- copies made that day stops the migration, and with it the next-api start (the running task keeps
-- serving). A database without those notes (tests, local, staging) is left unchanged.
-- Rollback: any image; this changes only values every image already reads. It keeps no copy of the
-- hotel's address it replaces (every copy had the same one), so undoing a row is a staff edit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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

DO $$
BEGIN
  IF (SELECT count(*) FROM vay2601_copies) > 30 THEN
    RAISE EXCEPTION 'VAY-2601: more than the 30 switch-day copies match';
  END IF;
END $$;

-- The copies to change: one note, a valid email in it, and the booker still on the hotel's address.
CREATE TEMPORARY TABLE vay2601_changes ON COMMIT DROP AS
SELECT copy.booking_guest_id, copy.guest_profile_id, copy.old_email, btrim(copy.new_email) AS new_email
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
      AND lower(btrim(other.old_email)) = lower(btrim(copy.old_email))
  );

-- The guest record, while it still holds the hotel's address and its changed copies agree.
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
  AND lower(btrim(profile.email)) = lower(btrim(agreed.old_email));

-- The copy's booker; applied to its guest record already, as after a staff edit.
UPDATE booking.booking_guests guest
SET email = change.new_email, updated_at = now(), guest_profile_synced_at = now()
FROM vay2601_changes change
WHERE guest.id = change.booking_guest_id;
