-- Migration: 0004_property_catalog
-- Owner: domain-hotels
-- See: engineering/public-hotel-profile-ownership.md, engineering/target-schema-ownership-map.md
--
-- Creates the canonical hotel/property catalog target tables needed for public
-- hotel identity, location, media, amenities, public contacts, locale,
-- timezone, and public policy projection.

CREATE SCHEMA IF NOT EXISTS hotel_catalog;

CREATE TABLE hotel_catalog.properties (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id             TEXT        NOT NULL UNIQUE,
  display_name          TEXT        NOT NULL CHECK (length(trim(display_name)) > 0),
  property_type         TEXT,
  category              TEXT,
  star_rating           NUMERIC(2, 1) CHECK (star_rating IS NULL OR star_rating BETWEEN 0 AND 5),
  default_locale        TEXT        NOT NULL DEFAULT 'en',
  supported_locales     TEXT[]      NOT NULL DEFAULT ARRAY['en']::TEXT[],
  profile_status        TEXT        NOT NULL DEFAULT 'incomplete'
                            CHECK (profile_status IN ('complete', 'incomplete', 'disabled', 'private')),
  completeness_reasons  TEXT[]      NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hotel_catalog.property_source_links (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  source_system  TEXT        NOT NULL CHECK (source_system IN ('booking', 'pms', 'marketplace', 'platform')),
  source_table   TEXT        NOT NULL,
  source_id      TEXT        NOT NULL,
  relationship   TEXT        NOT NULL CHECK (relationship IN ('canonical_input', 'profile_input', 'listing_input', 'operational_input')),
  status         TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'ignored')),
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_property_source_links_source UNIQUE (source_system, source_table, source_id),
  CONSTRAINT uq_property_source_links_property_source
    UNIQUE (property_id, source_system, source_table, source_id, relationship)
);

CREATE TABLE hotel_catalog.property_slugs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  slug             TEXT        NOT NULL,
  locale           TEXT,
  purpose          TEXT        NOT NULL CHECK (purpose IN ('canonical', 'redirect', 'marketplace_overlay')),
  status           TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redirected', 'retired')),
  redirects_to_id  UUID        REFERENCES hotel_catalog.property_slugs(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_property_slugs_redirect_target
    CHECK (
      (status = 'redirected' AND redirects_to_id IS NOT NULL)
      OR
      (status <> 'redirected' AND redirects_to_id IS NULL)
    )
);

CREATE TABLE hotel_catalog.property_domains (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  hostname        TEXT        NOT NULL UNIQUE,
  verification_status TEXT    NOT NULL CHECK (verification_status IN ('verified', 'pending', 'failed', 'disabled')),
  canonical_when_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_property_domains_id_property UNIQUE (id, property_id),
  CONSTRAINT chk_property_domains_normalized_hostname CHECK (hostname = lower(hostname)),
  CONSTRAINT chk_property_domains_canonical_verified
    CHECK (canonical_when_verified = FALSE OR verification_status = 'verified')
);

CREATE TABLE hotel_catalog.property_locations (
  property_id              UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  country_code             CHAR(2),
  region                   TEXT,
  city                     TEXT,
  street_address           TEXT,
  postal_code              TEXT,
  raw_marketplace_location TEXT,
  latitude                 NUMERIC(9, 6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude                NUMERIC(9, 6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  timezone                 TEXT,
  address_public           BOOLEAN     NOT NULL DEFAULT FALSE,
  geo_public               BOOLEAN     NOT NULL DEFAULT FALSE,
  map_display_mode         TEXT        NOT NULL DEFAULT 'hidden'
                                CHECK (map_display_mode IN ('hidden', 'approximate', 'exact')),
  source_confidence        TEXT        NOT NULL DEFAULT 'unverified'
                                CHECK (source_confidence IN ('verified', 'high', 'medium', 'low', 'unverified')),
  migration_notes          TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_property_locations_geo_pair
    CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL)),
  CONSTRAINT chk_property_locations_timezone
    CHECK (timezone IS NULL OR timezone ~ '^[A-Za-z_]+/[A-Za-z0-9_+./-]+$')
);

CREATE TABLE hotel_catalog.property_profiles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  locale            TEXT        NOT NULL,
  short_description TEXT,
  long_description  TEXT,
  public_notes      TEXT,
  source_confidence TEXT        NOT NULL DEFAULT 'unverified'
                       CHECK (source_confidence IN ('verified', 'high', 'medium', 'low', 'unverified')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_property_profiles_property_locale UNIQUE (property_id, locale)
);

CREATE TABLE hotel_catalog.property_media (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  media_type      TEXT        NOT NULL CHECK (media_type IN ('hero_image', 'gallery_image', 'logo')),
  url             TEXT        NOT NULL,
  alt_text        TEXT,
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  source_system   TEXT        NOT NULL CHECK (source_system IN ('booking', 'pms', 'marketplace', 'platform')),
  public_approved BOOLEAN     NOT NULL DEFAULT FALSE,
  rights_metadata JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hotel_catalog.property_amenities (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  amenity_key   TEXT        NOT NULL,
  label         TEXT        NOT NULL,
  source_system TEXT        NOT NULL CHECK (source_system IN ('booking', 'pms', 'marketplace', 'platform')),
  public_safe   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_property_amenities_property_key UNIQUE (property_id, amenity_key)
);

CREATE TABLE hotel_catalog.property_contact_channels (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  channel_type    TEXT        NOT NULL CHECK (channel_type IN ('phone', 'email', 'whatsapp', 'website', 'instagram', 'facebook', 'x')),
  value           TEXT        NOT NULL,
  is_public       BOOLEAN     NOT NULL DEFAULT FALSE,
  source_system   TEXT        NOT NULL CHECK (source_system IN ('booking', 'pms', 'marketplace', 'platform')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_property_contact_channels_property_type_value UNIQUE (property_id, channel_type, value)
);

CREATE TABLE hotel_catalog.property_policy_summaries (
  property_id                  UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  check_in_time                TIME,
  check_out_time               TIME,
  cancellation_summary         TEXT,
  cancellation_terms_url       TEXT,
  deposit_policy_summary       TEXT,
  payment_policy_summary       TEXT,
  policy_source_owner          TEXT        NOT NULL DEFAULT 'booking'
                                      CHECK (policy_source_owner IN ('booking', 'finance', 'hotel_catalog')),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hotel_catalog.property_public_profile_read_model (
  property_id          UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  public_id            TEXT        NOT NULL UNIQUE,
  display_name         TEXT        NOT NULL,
  canonical_slug       TEXT        NOT NULL,
  property_domain_id   UUID        REFERENCES hotel_catalog.property_domains(id),
  verified_custom_domain TEXT,
  default_locale       TEXT        NOT NULL,
  supported_locales    TEXT[]      NOT NULL,
  profile_status       TEXT        NOT NULL,
  completeness_reasons TEXT[]      NOT NULL DEFAULT '{}',
  location             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  descriptions         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  media                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  amenities            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  public_contacts      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  public_policy        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_freshness     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  projected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_property_public_profile_domain_same_property
    FOREIGN KEY (property_domain_id, property_id)
    REFERENCES hotel_catalog.property_domains(id, property_id)
);

CREATE INDEX idx_property_source_links_property
  ON hotel_catalog.property_source_links (property_id);

CREATE UNIQUE INDEX uq_property_slugs_slug_locale
  ON hotel_catalog.property_slugs (slug, COALESCE(locale, ''));

CREATE UNIQUE INDEX uq_property_slugs_active_canonical_property
  ON hotel_catalog.property_slugs (property_id)
  WHERE purpose = 'canonical' AND status = 'active';

CREATE UNIQUE INDEX uq_property_domains_hostname_lower
  ON hotel_catalog.property_domains (lower(hostname));

CREATE UNIQUE INDEX uq_property_domains_canonical_verified_property
  ON hotel_catalog.property_domains (property_id)
  WHERE canonical_when_verified = TRUE AND verification_status = 'verified';

CREATE INDEX idx_property_media_property_public
  ON hotel_catalog.property_media (property_id, public_approved);

CREATE INDEX idx_property_public_profile_status
  ON hotel_catalog.property_public_profile_read_model (profile_status);
