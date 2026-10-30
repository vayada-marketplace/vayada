-- Migration: 0528_booking_guest_data_settings
-- Owner: domain-booking / VAY-2420
--
-- Settings › Guest data, one per account (the property's active owner organization, as for
-- booking.guest_profiles): each guest field's status (off, optional, required), which details join a
-- new booking to an existing guest profile, and how long ID documents are kept after check-out.
--
-- One JSON object per account, validated by next-api; keys it doesn't hold fall back to the
-- defaults, so a new setting needs no migration. No row means the defaults, so nothing changes at
-- release. No foreign keys: account_id is not a table key (0527), and identity FKs are pinned (0500);
-- the editor is in the audit event.

SET LOCAL lock_timeout = '5s';

CREATE TABLE booking.guest_data_settings (
  account_id          UUID        PRIMARY KEY,
  settings            JSONB       NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  updated_by_user_id  UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE booking.guest_data_settings IS
  'VAY-2420: Settings › Guest data per account (guest field statuses, matching, ID retention). No row: the defaults.';
