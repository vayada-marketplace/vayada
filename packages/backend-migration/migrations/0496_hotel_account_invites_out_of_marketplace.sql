-- VAY-2272 (Marketplace removal step 5, W1). Held by hand: merged in release window W1 with
-- Flamur's yes, after the counts-0496 before-run; the after-run checks the release.
--
-- Hotel account invites (Vayada Admin issues them, Booking Admin /invite redeems them, prepared
-- hotel imports hang off them) leave the Marketplace schema: the table moves to
-- hotel_catalog.hotel_account_invites with its rows, keys, foreign keys and grants. Non-hotel
-- invites are test data (Flamur, 2026-10-18) and go, with the creator columns.
--
-- Rollback: any image. Images before this one keep reading and writing marketplace.invite_codes
-- through the compatibility view below until 0499 drops it. The view is a simple, auto-updatable
-- view in the marketplace schema, so the API login gets DML on it from that schema's default
-- privileges; migrations never GRANT the runtime login (VAY-2211).
SET LOCAL lock_timeout = '5s';

-- creator_profiles: dropping the creator foreign key removes its triggers there.
LOCK TABLE
  hotel_catalog.prepared_import_applications,
  marketplace.creator_profiles,
  marketplace.invite_codes
  IN ACCESS EXCLUSIVE MODE;

DELETE FROM marketplace.invite_codes WHERE invite_type <> 'hotel';

ALTER TABLE marketplace.invite_codes
  DROP CONSTRAINT fk_marketplace_invite_codes_creator_org,
  DROP COLUMN creator_profile_id,
  DROP COLUMN creator_organization_id,
  DROP CONSTRAINT invite_codes_invite_type_check,
  ADD CONSTRAINT chk_hotel_account_invites_type CHECK (invite_type = 'hotel'),
  ALTER COLUMN invite_type SET DEFAULT 'hotel';

ALTER TABLE marketplace.invite_codes SET SCHEMA hotel_catalog;
ALTER TABLE hotel_catalog.invite_codes RENAME TO hotel_account_invites;
ALTER TABLE hotel_catalog.hotel_account_invites
  RENAME CONSTRAINT invite_codes_pkey TO hotel_account_invites_pkey;
ALTER TABLE hotel_catalog.hotel_account_invites
  RENAME CONSTRAINT invite_codes_code_key TO hotel_account_invites_code_key;
ALTER TABLE hotel_catalog.hotel_account_invites
  RENAME CONSTRAINT invite_codes_created_by_user_id_fkey
  TO hotel_account_invites_created_by_user_id_fkey;
ALTER TABLE hotel_catalog.hotel_account_invites
  RENAME CONSTRAINT invite_codes_redeemed_by_user_id_fkey
  TO hotel_account_invites_redeemed_by_user_id_fkey;
ALTER TABLE hotel_catalog.hotel_account_invites
  RENAME CONSTRAINT invite_codes_property_id_fkey TO hotel_account_invites_property_id_fkey;
ALTER TABLE hotel_catalog.hotel_account_invites
  RENAME CONSTRAINT chk_marketplace_invite_codes_status TO chk_hotel_account_invites_status;
ALTER TABLE hotel_catalog.hotel_account_invites
  RENAME CONSTRAINT chk_marketplace_invite_codes_dates TO chk_hotel_account_invites_dates;
ALTER INDEX hotel_catalog.idx_marketplace_invite_codes_status
  RENAME TO idx_hotel_account_invites_status;

-- Images before this one never read the two dropped columns; they insert, lock, update and read
-- the rest through this view. Base-table defaults apply to columns they leave out.
CREATE VIEW marketplace.invite_codes AS
  SELECT id, code, invite_type, status, payload, created_by_user_id, redeemed_by_user_id,
         property_id, redeemed_at, expires_at, created_at
  FROM hotel_catalog.hotel_account_invites;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM hotel_catalog.hotel_account_invites WHERE invite_type <> 'hotel') THEN
    RAISE EXCEPTION 'Non-hotel invites remain';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint con
       WHERE con.conrelid = 'hotel_catalog.hotel_account_invites'::regclass
         AND con.contype IN ('p', 'u', 'f', 'c')
         AND (con.conname LIKE '%marketplace%' OR con.conname LIKE '%invite_codes%'))
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_index idx
       JOIN pg_catalog.pg_class index_class ON index_class.oid = idx.indexrelid
       WHERE idx.indrelid = 'hotel_catalog.hotel_account_invites'::regclass
         AND (index_class.relname LIKE '%marketplace%' OR index_class.relname LIKE '%invite_codes%'))
  THEN
    RAISE EXCEPTION 'hotel_catalog.hotel_account_invites keeps a Marketplace constraint or index name';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class view_class
       JOIN pg_catalog.pg_namespace view_schema ON view_schema.oid = view_class.relnamespace
       WHERE view_schema.nspname = 'marketplace' AND view_class.relname = 'invite_codes'
         AND view_class.relkind = 'v')
     OR (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'marketplace' AND table_name = 'invite_codes') <> 11
  THEN
    RAISE EXCEPTION 'The marketplace.invite_codes compatibility view is missing or incomplete';
  END IF;
END $$;
