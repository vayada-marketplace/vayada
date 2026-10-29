-- Migration: 0527_booking_guest_profiles
-- Owner: domain-booking / VAY-2420
--
-- One guest profile per person and account, so every stay of a guest shows in one place. The account is the
-- property's active owner organization; a property without exactly one owner link is its own account. No foreign
-- key on account_id for that reason, and because identity FKs are pinned (0500).
--
-- booking.booking_guests stays each booking's own copy of what was booked (emails, finance, find-my-booking and
-- the channel data keep reading it). A background job in next-api links every booking guest to a profile and
-- copies its values over; these columns say which profile, how it was found, which copy was last applied, and
-- that email and phone wait until the property may see them (commission plan, request not yet accepted).
--
-- date_of_birth, document_type, document_number and guest_notes are written from the guest API in the next
-- part of VAY-2420; check-in keeps writing pms.guest_registrations until then.

SET LOCAL lock_timeout = '5s';

CREATE TABLE booking.guest_profiles (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID        NOT NULL,
  first_name       TEXT        NOT NULL,
  last_name        TEXT        NOT NULL,
  email            TEXT,
  phone            TEXT,
  country_code     CHAR(2),
  date_of_birth    DATE,
  document_type    TEXT        CHECK (document_type IN ('passport', 'national_id', 'driving_licence', 'other')),
  document_number  TEXT        CHECK (document_number IS NULL OR char_length(document_number) BETWEEN 1 AND 64),
  -- Lower-case "first last" with single spaces: what automatic matching compares.
  name_key         TEXT        GENERATED ALWAYS AS (
                     lower(regexp_replace(btrim(first_name || ' ' || last_name), '\s+', ' ', 'g'))
                   ) STORED,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_guest_profiles_country_supported
    CHECK (country_code IS NULL OR booking.is_supported_nationality_code(country_code)),
  CONSTRAINT chk_guest_profiles_birth_date
    CHECK (date_of_birth IS NULL OR date_of_birth BETWEEN DATE '1900-01-01' AND DATE '2100-01-01')
);

CREATE INDEX idx_guest_profiles_account_name ON booking.guest_profiles (account_id, name_key);

ALTER TABLE booking.booking_guests
  ADD COLUMN guest_profile_id UUID REFERENCES booking.guest_profiles(id),
  ADD COLUMN guest_profile_link TEXT
    CHECK (guest_profile_link IN ('matched_email', 'matched_phone', 'created', 'merged', 'separated')),
  ADD COLUMN guest_profile_synced_at TIMESTAMPTZ,
  ADD COLUMN guest_profile_contact_deferred BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT chk_booking_guests_profile_link
    CHECK ((guest_profile_id IS NULL) = (guest_profile_link IS NULL));

CREATE INDEX idx_booking_guests_guest_profile
  ON booking.booking_guests (guest_profile_id)
  WHERE guest_profile_id IS NOT NULL;

-- What the background job still has to do: link, re-apply a changed copy, or apply contact later.
CREATE INDEX idx_booking_guests_profile_pending
  ON booking.booking_guests (created_at)
  WHERE guest_profile_id IS NULL
     OR guest_profile_synced_at IS DISTINCT FROM updated_at
     OR guest_profile_contact_deferred;

COMMENT ON COLUMN booking.booking_guests.guest_profile_synced_at IS
  'VAY-2420: updated_at of this row when its values were last applied to the profile.';

-- Staff-only notes about a guest, shown on every stay. property_id is where it was written.
CREATE TABLE booking.guest_notes (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_profile_id    UUID        NOT NULL REFERENCES booking.guest_profiles(id) ON DELETE CASCADE,
  property_id         UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  body                TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_by_user_id  UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_guest_notes_profile ON booking.guest_notes (guest_profile_id, created_at DESC);

COMMENT ON TABLE booking.guest_profiles IS
  'VAY-2420: one guest per person and account; booking_guests rows point here through guest_profile_id.';
COMMENT ON TABLE booking.guest_notes IS
  'VAY-2420: staff-only notes kept across all stays of a guest profile.';
