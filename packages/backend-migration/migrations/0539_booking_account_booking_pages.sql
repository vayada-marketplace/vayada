-- Migration: 0539_booking_account_booking_pages
-- Owner: domain-booking / VAY-2456
--
-- The agency booking page (VAY-2450): one public booking page per account (an identity.organizations row
-- of kind hotel_group) that lists the account's stays. One row per account holds the page's address slug,
-- its Live switch, its settings (one JSON object, validated by next-api with @vayada/domain-booking) and a
-- revision for safe saves. The included properties and their order for "Recommended" sit beside it.
--
-- An agency address and a hotel address share one namespace: both are `<slug>.next-booking.vayada.com`.
-- One trigger function on both tables refuses a slug the other side holds. It takes one transaction-level
-- advisory lock per slug first, so two writers can't each miss the other's uncommitted row. Hotel slugs are
-- unique for good (former addresses keep redirecting), so every property_slugs row counts, whatever its
-- purpose, status or locale. It is SECURITY DEFINER because hotel slug writers need not read
-- booking.account_booking_pages; nobody may EXECUTE it (triggers fire without that check), as the runtime
-- preflight requires.

SET LOCAL lock_timeout = '5s';

CREATE TABLE booking.account_booking_pages (
  organization_id UUID        PRIMARY KEY REFERENCES identity.organizations(id) ON DELETE CASCADE,
  slug            TEXT        NOT NULL CONSTRAINT uq_account_booking_pages_slug UNIQUE,
  live            BOOLEAN     NOT NULL DEFAULT FALSE,
  settings        JSONB       NOT NULL,
  revision        INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_account_booking_pages_slug CHECK (
    length(slug) <= 63 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND slug NOT IN ('www', 'booking')
  ),
  CONSTRAINT chk_account_booking_pages_settings CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT chk_account_booking_pages_revision CHECK (revision BETWEEN 1 AND 2147483647)
);

COMMENT ON TABLE booking.account_booking_pages IS
  'Agency booking page (VAY-2450/VAY-2456): one public page per account listing its stays. settings is validated by next-api.';

CREATE TABLE booking.account_booking_page_properties (
  organization_id UUID    NOT NULL
                    REFERENCES booking.account_booking_pages(organization_id) ON DELETE CASCADE,
  property_id     UUID    NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9999),
  PRIMARY KEY (organization_id, property_id),
  CONSTRAINT uq_account_booking_page_properties_position UNIQUE (organization_id, position)
);

CREATE INDEX ix_account_booking_page_properties_property
  ON booking.account_booking_page_properties (property_id);

COMMENT ON TABLE booking.account_booking_page_properties IS
  'Properties an agency booking page includes, in their "Recommended" order (VAY-2456). Whether each one is ready is read live.';

CREATE FUNCTION booking.refuse_shared_booking_address()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vayada.booking-address:' || NEW.slug, 0)
  );
  IF TG_TABLE_NAME = 'account_booking_pages' THEN
    IF EXISTS (SELECT 1 FROM hotel_catalog.property_slugs s WHERE s.slug = NEW.slug) THEN
      RAISE EXCEPTION 'booking address % belongs to a hotel', NEW.slug
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'uq_booking_address_slug';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM booking.account_booking_pages p WHERE p.slug = NEW.slug) THEN
    RAISE EXCEPTION 'booking address % belongs to an agency booking page', NEW.slug
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'uq_booking_address_slug';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION booking.refuse_shared_booking_address() FROM PUBLIC;

CREATE TRIGGER trg_account_booking_pages_shared_address
  BEFORE INSERT OR UPDATE OF slug ON booking.account_booking_pages
  FOR EACH ROW EXECUTE FUNCTION booking.refuse_shared_booking_address();

CREATE TRIGGER trg_property_slugs_shared_address
  BEFORE INSERT OR UPDATE OF slug ON hotel_catalog.property_slugs
  FOR EACH ROW EXECUTE FUNCTION booking.refuse_shared_booking_address();
