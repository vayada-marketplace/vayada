-- Migration: 0008_marketplace
-- Owner: domain-marketplace
-- See: engineering/target-schema-migration-coverage.md, engineering/target-schema-ownership-map.md
--
-- Creates the marketplace target schema for creator profiles, marketplace hotel
-- overlays, collaboration listings, collaboration lifecycle records, chat,
-- creator travel planning, invites, notifications, newsletter preferences, and
-- a public-safe listing read model.
--
-- Legacy Marketplace tables are migration/parity inputs only. Runtime
-- TypeScript code must not use this migration as a reason to read the legacy
-- Marketplace database directly.

CREATE SCHEMA IF NOT EXISTS marketplace;

CREATE FUNCTION marketplace.jsonb_has_forbidden_public_key(
  document JSONB,
  forbidden_keys TEXT[]
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  WITH RECURSIVE json_walk(value) AS (
    SELECT document
    UNION ALL
    SELECT child.value
    FROM json_walk
    CROSS JOIN LATERAL (
      SELECT object_child.value
      FROM jsonb_each(
        CASE
          WHEN jsonb_typeof(json_walk.value) = 'object'
          THEN json_walk.value
          ELSE '{}'::jsonb
        END
      ) AS object_child(key, value)
      UNION ALL
      SELECT array_child.value
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(json_walk.value) = 'array'
          THEN json_walk.value
          ELSE '[]'::jsonb
        END
      ) AS array_child(value)
    ) AS child(value)
  )
  SELECT EXISTS (
    SELECT 1
    FROM json_walk
    CROSS JOIN LATERAL jsonb_object_keys(
      CASE
        WHEN jsonb_typeof(json_walk.value) = 'object'
        THEN json_walk.value
        ELSE '{}'::jsonb
      END
    ) AS object_keys(key)
    WHERE EXISTS (
      SELECT 1
      FROM unnest(forbidden_keys) AS forbidden(forbidden_key)
      WHERE lower(regexp_replace(object_keys.key, '[^a-zA-Z0-9]', '', 'g')) =
            lower(regexp_replace(forbidden.forbidden_key, '[^a-zA-Z0-9]', '', 'g'))
    )
  );
$$;

CREATE FUNCTION marketplace.jsonb_has_marketplace_private_key(document JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT marketplace.jsonb_has_forbidden_public_key(
    document,
    ARRAY[
      'affiliate_link', 'affiliate_referral_code', 'application_message',
      'body', 'commission_rule_id', 'content', 'created_by_user_id',
      'creator_fee', 'email', 'latitude', 'longitude',
      'message_body', 'message_metadata', 'negotiated_terms',
      'organization_id', 'phone', 'pii_retention_until',
      'postal_code', 'private_notes', 'raw_marketplace_location',
      'redeemed_by_user_id', 'source_collaboration_id',
      'source_creator_id', 'source_hotel_profile_id',
      'source_listing_id', 'street_address', 'user_id'
    ]::TEXT[]
  );
$$;

ALTER TABLE finance.commission_rules
  ADD CONSTRAINT uq_finance_commission_rules_id_organization
  UNIQUE (id, organization_id);

CREATE TABLE marketplace.creator_profiles (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            UUID        NOT NULL REFERENCES identity.organizations(id),
  owner_user_id              UUID        REFERENCES identity.users(id),
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_creator_id          TEXT,
  display_name               TEXT,
  creator_type               TEXT        NOT NULL DEFAULT 'lifestyle'
                                  CHECK (creator_type IN ('lifestyle', 'travel', 'other', 'migration')),
  location_text              TEXT,
  short_description          TEXT,
  portfolio_url              TEXT,
  phone                      TEXT,
  profile_picture_url        TEXT,
  profile_complete           BOOLEAN     NOT NULL DEFAULT FALSE,
  profile_completed_at       TIMESTAMPTZ,
  profile_status             TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (profile_status IN ('pending', 'active', 'rejected', 'suspended', 'archived')),
  profile_metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  pii_retention_until        DATE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_creator_profiles_id_org
    UNIQUE (id, organization_id),
  CONSTRAINT uq_marketplace_creator_profiles_source
    UNIQUE (source_system, source_creator_id),
  CONSTRAINT chk_marketplace_creator_profiles_source_id
    CHECK (source_system = 'marketplace' OR source_creator_id IS NOT NULL)
);

CREATE INDEX idx_marketplace_creator_profiles_org_status
  ON marketplace.creator_profiles (organization_id, profile_status);

CREATE TABLE marketplace.creator_platforms (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_profile_id         UUID        NOT NULL,
  organization_id            UUID        NOT NULL,
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_platform_id         TEXT,
  platform                   TEXT        NOT NULL
                                  CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'facebook', 'blog', 'x', 'other')),
  handle                     TEXT        NOT NULL,
  profile_url                TEXT,
  follower_count             INTEGER     NOT NULL DEFAULT 0,
  engagement_rate            NUMERIC(7, 4) NOT NULL DEFAULT 0,
  audience_countries         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  audience_age_groups        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  audience_gender_split      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  verification_status        TEXT        NOT NULL DEFAULT 'unverified'
                                  CHECK (verification_status IN ('unverified', 'verified', 'rejected', 'stale')),
  platform_metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_creator_platforms_source
    UNIQUE (source_system, source_platform_id),
  CONSTRAINT chk_marketplace_creator_platform_followers
    CHECK (follower_count >= 0),
  CONSTRAINT chk_marketplace_creator_platform_engagement
    CHECK (engagement_rate >= 0),
  CONSTRAINT chk_marketplace_creator_platforms_source_id
    CHECK (source_system = 'marketplace' OR source_platform_id IS NOT NULL),
  CONSTRAINT fk_marketplace_creator_platforms_creator_org
    FOREIGN KEY (creator_profile_id, organization_id)
    REFERENCES marketplace.creator_profiles(id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_creator_platforms_creator
  ON marketplace.creator_platforms (creator_profile_id);

CREATE TABLE marketplace.marketplace_hotel_profiles (
  property_id                UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  organization_id            UUID        NOT NULL REFERENCES identity.organizations(id),
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_hotel_profile_id    TEXT,
  marketplace_profile_status TEXT        NOT NULL DEFAULT 'pending',
  profile_complete           BOOLEAN     NOT NULL DEFAULT FALSE,
  profile_completed_at       TIMESTAMPTZ,
  host_summary               TEXT,
  collaboration_guidelines   TEXT,
  marketplace_metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_hotel_profiles_property_org
    UNIQUE (property_id, organization_id),
  CONSTRAINT uq_marketplace_hotel_profiles_source
    UNIQUE (source_system, source_hotel_profile_id),
  CONSTRAINT chk_marketplace_hotel_profiles_status
    CHECK (marketplace_profile_status IN ('pending', 'verified', 'rejected', 'suspended', 'archived')),
  CONSTRAINT chk_marketplace_hotel_profiles_source_id
    CHECK (source_system = 'marketplace' OR source_hotel_profile_id IS NOT NULL)
);

CREATE INDEX idx_marketplace_hotel_profiles_org_status
  ON marketplace.marketplace_hotel_profiles (organization_id, marketplace_profile_status);

CREATE TABLE marketplace.marketplace_hotel_listings (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  organization_id            UUID        NOT NULL,
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_listing_id          TEXT,
  title                      TEXT        NOT NULL,
  listing_summary            TEXT,
  accommodation_type         TEXT
                                  CHECK (
                                    accommodation_type IS NULL
                                    OR accommodation_type IN (
                                      'hotel', 'resort', 'boutique_hotel',
                                      'lodge', 'apartment', 'villa', 'other'
                                    )
                                  ),
  listing_status             TEXT        NOT NULL DEFAULT 'pending',
  raw_location_text          TEXT,
  image_urls                 TEXT[]      NOT NULL DEFAULT '{}',
  listing_metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_hotel_listings_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_marketplace_hotel_listings_id_property_org
    UNIQUE (id, property_id, organization_id),
  CONSTRAINT uq_marketplace_hotel_listings_source
    UNIQUE (source_system, source_listing_id),
  CONSTRAINT chk_marketplace_hotel_listings_status
    CHECK (listing_status IN ('draft', 'pending', 'verified', 'rejected', 'suspended', 'archived')),
  CONSTRAINT chk_marketplace_hotel_listings_source_id
    CHECK (source_system = 'marketplace' OR source_listing_id IS NOT NULL),
  CONSTRAINT fk_marketplace_hotel_listings_profile_org
    FOREIGN KEY (property_id, organization_id)
    REFERENCES marketplace.marketplace_hotel_profiles(property_id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_hotel_listings_property_status
  ON marketplace.marketplace_hotel_listings (property_id, listing_status);

CREATE TABLE marketplace.listing_collaboration_offerings (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id                 UUID        NOT NULL,
  property_id                UUID        NOT NULL,
  organization_id            UUID        NOT NULL,
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_offering_id         TEXT,
  collaboration_type         TEXT        NOT NULL
                                  CHECK (collaboration_type IN ('free_stay', 'paid', 'discount', 'affiliate')),
  availability_months        TEXT[]      NOT NULL DEFAULT '{}',
  platforms                  TEXT[]      NOT NULL DEFAULT '{}',
  free_stay_min_nights       INTEGER,
  free_stay_max_nights       INTEGER,
  paid_max_amount            NUMERIC(15, 2),
  discount_percentage        INTEGER,
  commission_percentage      NUMERIC(7, 4),
  min_followers              INTEGER,
  currency                   CHAR(3)     NOT NULL DEFAULT 'USD',
  terms_summary              TEXT,
  offering_metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_offerings_source
    UNIQUE (source_system, source_offering_id),
  CONSTRAINT chk_marketplace_offerings_source_id
    CHECK (source_system = 'marketplace' OR source_offering_id IS NOT NULL),
  CONSTRAINT chk_marketplace_offerings_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_marketplace_offerings_type_terms
    CHECK (
      (
        collaboration_type <> 'free_stay'
        OR (
          free_stay_min_nights IS NOT NULL
          AND free_stay_max_nights IS NOT NULL
          AND free_stay_min_nights > 0
          AND free_stay_max_nights >= free_stay_min_nights
        )
      )
      AND (
        collaboration_type <> 'paid'
        OR (paid_max_amount IS NOT NULL AND paid_max_amount > 0)
      )
      AND (
        collaboration_type <> 'discount'
        OR (discount_percentage IS NOT NULL AND discount_percentage BETWEEN 1 AND 100)
      )
      AND (
        collaboration_type <> 'affiliate'
        OR (commission_percentage IS NOT NULL AND commission_percentage BETWEEN 1 AND 100)
      )
      AND (min_followers IS NULL OR min_followers > 0)
    ),
  CONSTRAINT fk_marketplace_offerings_listing_org
    FOREIGN KEY (listing_id, property_id, organization_id)
    REFERENCES marketplace.marketplace_hotel_listings(id, property_id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_offerings_listing_type
  ON marketplace.listing_collaboration_offerings (listing_id, collaboration_type);

CREATE TABLE marketplace.listing_creator_requirements (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id                 UUID        NOT NULL,
  property_id                UUID        NOT NULL,
  organization_id            UUID        NOT NULL,
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_requirement_id      TEXT,
  platforms                  TEXT[]      NOT NULL DEFAULT '{}',
  target_countries           TEXT[],
  target_age_min             INTEGER,
  target_age_max             INTEGER,
  target_age_groups          TEXT[]      NOT NULL DEFAULT '{}',
  creator_types              TEXT[]      NOT NULL DEFAULT '{}',
  requirement_metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_requirements_listing
    UNIQUE (listing_id),
  CONSTRAINT uq_marketplace_requirements_source
    UNIQUE (source_system, source_requirement_id),
  CONSTRAINT chk_marketplace_requirements_source_id
    CHECK (source_system = 'marketplace' OR source_requirement_id IS NOT NULL),
  CONSTRAINT chk_marketplace_requirements_age_range
    CHECK (
      (target_age_min IS NULL OR target_age_min BETWEEN 0 AND 100)
      AND (target_age_max IS NULL OR target_age_max BETWEEN 0 AND 100)
      AND (
        target_age_min IS NULL
        OR target_age_max IS NULL
        OR target_age_max >= target_age_min
      )
    ),
  CONSTRAINT fk_marketplace_requirements_listing_org
    FOREIGN KEY (listing_id, property_id, organization_id)
    REFERENCES marketplace.marketplace_hotel_listings(id, property_id, organization_id)
    ON DELETE CASCADE
);

CREATE TABLE marketplace.collaborations (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_profile_id         UUID        NOT NULL,
  creator_organization_id    UUID        NOT NULL,
  property_id                UUID        NOT NULL,
  hotel_organization_id      UUID        NOT NULL,
  listing_id                 UUID        NOT NULL,
  commission_rule_id         UUID,
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_collaboration_id    TEXT,
  initiator_type             TEXT        NOT NULL
                                  CHECK (initiator_type IN ('creator', 'hotel', 'platform', 'migration')),
  lifecycle_status           TEXT        NOT NULL DEFAULT 'pending',
  collaboration_type         TEXT
                                  CHECK (
                                    collaboration_type IS NULL
                                    OR collaboration_type IN ('free_stay', 'paid', 'discount', 'affiliate', 'custom')
                                  ),
  application_message        TEXT,
  negotiated_terms           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  platform_deliverables      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  preferred_months           TEXT[]      NOT NULL DEFAULT '{}',
  travel_date_from           DATE,
  travel_date_to             DATE,
  preferred_date_from        DATE,
  preferred_date_to          DATE,
  free_stay_min_nights       INTEGER,
  free_stay_max_nights       INTEGER,
  paid_amount                NUMERIC(15, 2),
  discount_percentage        INTEGER,
  creator_fee                NUMERIC(7, 4),
  currency                   CHAR(3)     NOT NULL DEFAULT 'USD',
  affiliate_referral_code    TEXT,
  affiliate_link             TEXT,
  creator_consent            BOOLEAN,
  hotel_agreed_at            TIMESTAMPTZ,
  creator_agreed_at          TIMESTAMPTZ,
  term_last_updated_at       TIMESTAMPTZ,
  responded_at               TIMESTAMPTZ,
  cancelled_at               TIMESTAMPTZ,
  completed_at               TIMESTAMPTZ,
  collaboration_metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_collaborations_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_marketplace_collaborations_id_property_creator
    UNIQUE (id, property_id, creator_profile_id),
  CONSTRAINT uq_marketplace_collaborations_source
    UNIQUE (source_system, source_collaboration_id),
  CONSTRAINT chk_marketplace_collaborations_source_id
    CHECK (source_system = 'marketplace' OR source_collaboration_id IS NOT NULL),
  CONSTRAINT chk_marketplace_collaborations_status
    CHECK (lifecycle_status IN ('pending', 'negotiating', 'accepted', 'declined', 'completed', 'cancelled')),
  CONSTRAINT chk_marketplace_collaborations_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_marketplace_collaborations_type_terms
    CHECK (
      (
        collaboration_type IS DISTINCT FROM 'free_stay'
        OR (
          free_stay_min_nights IS NOT NULL
          AND free_stay_max_nights IS NOT NULL
          AND free_stay_min_nights > 0
          AND free_stay_max_nights >= free_stay_min_nights
        )
      )
      AND (
        collaboration_type IS DISTINCT FROM 'paid'
        OR (paid_amount IS NOT NULL AND paid_amount > 0)
      )
      AND (
        collaboration_type IS DISTINCT FROM 'discount'
        OR (discount_percentage IS NOT NULL AND discount_percentage BETWEEN 1 AND 100)
      )
      AND (
        collaboration_type IS DISTINCT FROM 'affiliate'
        OR (creator_fee IS NOT NULL AND creator_fee BETWEEN 1 AND 100)
      )
      AND (initiator_type <> 'creator' OR creator_consent IS TRUE)
    ),
  CONSTRAINT chk_marketplace_collaborations_travel_dates
    CHECK (travel_date_from IS NULL OR travel_date_to IS NULL OR travel_date_to >= travel_date_from),
  CONSTRAINT chk_marketplace_collaborations_preferred_dates
    CHECK (preferred_date_from IS NULL OR preferred_date_to IS NULL OR preferred_date_to >= preferred_date_from),
  CONSTRAINT fk_marketplace_collaborations_creator_org
    FOREIGN KEY (creator_profile_id, creator_organization_id)
    REFERENCES marketplace.creator_profiles(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_marketplace_collaborations_listing_org
    FOREIGN KEY (listing_id, property_id, hotel_organization_id)
    REFERENCES marketplace.marketplace_hotel_listings(id, property_id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_marketplace_collaborations_commission_rule
    FOREIGN KEY (commission_rule_id, hotel_organization_id)
    REFERENCES finance.commission_rules(id, organization_id)
    ON DELETE SET NULL (commission_rule_id)
);

CREATE UNIQUE INDEX uq_marketplace_collaborations_active_listing_creator
  ON marketplace.collaborations (listing_id, creator_profile_id)
  WHERE lifecycle_status IN ('pending', 'negotiating', 'accepted');

CREATE INDEX idx_marketplace_collaborations_creator_status
  ON marketplace.collaborations (creator_profile_id, lifecycle_status);

CREATE INDEX idx_marketplace_collaborations_property_status
  ON marketplace.collaborations (property_id, lifecycle_status);

CREATE TABLE marketplace.creator_ratings (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_profile_id         UUID        NOT NULL,
  creator_organization_id    UUID        NOT NULL,
  property_id                UUID        NOT NULL,
  hotel_organization_id      UUID        NOT NULL,
  collaboration_id           UUID,
  rating                     INTEGER     NOT NULL,
  comment                    TEXT,
  created_by_user_id         UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_creator_ratings_collaboration
    UNIQUE (collaboration_id),
  CONSTRAINT chk_marketplace_creator_ratings_score
    CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_marketplace_ratings_creator_org
    FOREIGN KEY (creator_profile_id, creator_organization_id)
    REFERENCES marketplace.creator_profiles(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_marketplace_ratings_hotel_profile_org
    FOREIGN KEY (property_id, hotel_organization_id)
    REFERENCES marketplace.marketplace_hotel_profiles(property_id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_marketplace_ratings_collaboration_creator
    FOREIGN KEY (collaboration_id, property_id, creator_profile_id)
    REFERENCES marketplace.collaborations(id, property_id, creator_profile_id)
    ON DELETE SET NULL (collaboration_id)
);

CREATE INDEX idx_marketplace_creator_ratings_creator
  ON marketplace.creator_ratings (creator_profile_id);

CREATE TABLE marketplace.collaboration_deliverables (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  collaboration_id           UUID        NOT NULL,
  property_id                UUID        NOT NULL,
  platform                   TEXT        NOT NULL,
  deliverable_type           TEXT        NOT NULL,
  quantity                   INTEGER     NOT NULL DEFAULT 1,
  deliverable_status         TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (deliverable_status IN ('pending', 'submitted', 'approved', 'rejected', 'completed')),
  due_at                     TIMESTAMPTZ,
  submitted_at               TIMESTAMPTZ,
  completed_at               TIMESTAMPTZ,
  content_url                TEXT,
  review_notes               TEXT,
  deliverable_metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_marketplace_deliverables_quantity
    CHECK (quantity > 0),
  CONSTRAINT fk_marketplace_deliverables_collaboration_property
    FOREIGN KEY (collaboration_id, property_id)
    REFERENCES marketplace.collaborations(id, property_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_deliverables_collaboration_status
  ON marketplace.collaboration_deliverables (collaboration_id, deliverable_status);

CREATE TABLE marketplace.marketplace_chat_messages (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  collaboration_id           UUID        NOT NULL,
  property_id                UUID        NOT NULL,
  sender_user_id             UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  sender_type                TEXT        NOT NULL
                                  CHECK (sender_type IN ('creator', 'hotel', 'platform_admin', 'system', 'migration')),
  message_type               TEXT        NOT NULL DEFAULT 'text'
                                  CHECK (message_type IN ('text', 'image', 'system')),
  body                       TEXT        NOT NULL,
  message_metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  read_at                    TIMESTAMPTZ,
  pii_retention_until        DATE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_marketplace_chat_sender_shape
    CHECK (
      (sender_type IN ('system', 'migration') AND sender_user_id IS NULL)
      OR sender_type NOT IN ('system', 'migration')
    ),
  CONSTRAINT fk_marketplace_chat_collaboration_property
    FOREIGN KEY (collaboration_id, property_id)
    REFERENCES marketplace.collaborations(id, property_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_chat_collaboration_created
  ON marketplace.marketplace_chat_messages (collaboration_id, created_at);

CREATE TABLE marketplace.trips (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_profile_id         UUID        NOT NULL,
  organization_id            UUID        NOT NULL,
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_trip_id             TEXT,
  name                       TEXT        NOT NULL,
  location_text              TEXT,
  start_date                 DATE        NOT NULL,
  end_date                   DATE        NOT NULL,
  notes                      TEXT,
  trip_metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_trips_id_creator
    UNIQUE (id, creator_profile_id),
  CONSTRAINT uq_marketplace_trips_source
    UNIQUE (source_system, source_trip_id),
  CONSTRAINT chk_marketplace_trips_source_id
    CHECK (source_system = 'marketplace' OR source_trip_id IS NOT NULL),
  CONSTRAINT chk_marketplace_trips_date_order
    CHECK (end_date >= start_date),
  CONSTRAINT fk_marketplace_trips_creator_org
    FOREIGN KEY (creator_profile_id, organization_id)
    REFERENCES marketplace.creator_profiles(id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_trips_creator_dates
  ON marketplace.trips (creator_profile_id, start_date, end_date);

CREATE TABLE marketplace.external_collaborations (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_profile_id         UUID        NOT NULL,
  organization_id            UUID        NOT NULL,
  trip_id                    UUID,
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_external_collaboration_id TEXT,
  title                      TEXT        NOT NULL,
  hotel_name                 TEXT,
  location_text              TEXT,
  collaboration_type         TEXT
                                  CHECK (
                                    collaboration_type IS NULL
                                    OR collaboration_type IN ('custom_external', 'paid', 'free_stay', 'affiliate', 'other')
                                  ),
  start_date                 DATE        NOT NULL,
  end_date                   DATE        NOT NULL,
  deliverables_summary       TEXT,
  notes                      TEXT,
  external_metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_external_collaborations_source
    UNIQUE (source_system, source_external_collaboration_id),
  CONSTRAINT chk_marketplace_external_collaborations_source_id
    CHECK (source_system = 'marketplace' OR source_external_collaboration_id IS NOT NULL),
  CONSTRAINT chk_marketplace_external_collaborations_date_order
    CHECK (end_date >= start_date),
  CONSTRAINT fk_marketplace_external_collaborations_creator_org
    FOREIGN KEY (creator_profile_id, organization_id)
    REFERENCES marketplace.creator_profiles(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_marketplace_external_collaborations_trip_creator
    FOREIGN KEY (trip_id, creator_profile_id)
    REFERENCES marketplace.trips(id, creator_profile_id)
    ON DELETE SET NULL (trip_id)
);

CREATE INDEX idx_marketplace_external_collaborations_creator
  ON marketplace.external_collaborations (creator_profile_id);

CREATE TABLE marketplace.marketplace_notifications (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id          UUID        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  organization_id            UUID        REFERENCES identity.organizations(id) ON DELETE SET NULL,
  notification_type          TEXT        NOT NULL,
  title                      TEXT        NOT NULL,
  body                       TEXT        NOT NULL,
  link_url                   TEXT,
  resource_type              TEXT,
  resource_id                TEXT,
  notification_metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  read_at                    TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_marketplace_notifications_user_created
  ON marketplace.marketplace_notifications (recipient_user_id, created_at DESC);

CREATE INDEX idx_marketplace_notifications_user_unread
  ON marketplace.marketplace_notifications (recipient_user_id)
  WHERE read_at IS NULL;

CREATE TABLE marketplace.invite_codes (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                       TEXT        NOT NULL UNIQUE,
  invite_type                TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (invite_type IN ('marketplace', 'creator', 'hotel', 'affiliate', 'migration')),
  status                     TEXT        NOT NULL DEFAULT 'pending',
  payload                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id         UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  redeemed_by_user_id        UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  creator_profile_id         UUID,
  creator_organization_id    UUID,
  property_id                UUID        REFERENCES hotel_catalog.properties(id) ON DELETE SET NULL,
  redeemed_at                TIMESTAMPTZ,
  expires_at                 TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_marketplace_invite_codes_status
    CHECK (status IN ('pending', 'redeemed', 'expired', 'revoked')),
  CONSTRAINT chk_marketplace_invite_codes_dates
    CHECK (redeemed_at IS NULL OR redeemed_at >= created_at),
  CONSTRAINT fk_marketplace_invite_codes_creator_org
    FOREIGN KEY (creator_profile_id, creator_organization_id)
    REFERENCES marketplace.creator_profiles(id, organization_id)
    ON DELETE SET NULL (creator_profile_id, creator_organization_id)
);

CREATE INDEX idx_marketplace_invite_codes_status
  ON marketplace.invite_codes (status);

CREATE TABLE marketplace.newsletter_preferences (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID        NOT NULL UNIQUE REFERENCES identity.users(id) ON DELETE CASCADE,
  organization_id            UUID        REFERENCES identity.organizations(id) ON DELETE SET NULL,
  enabled                    BOOLEAN     NOT NULL DEFAULT TRUE,
  country_filter             TEXT[],
  source_system              TEXT        NOT NULL DEFAULT 'marketplace'
                                  CHECK (source_system IN ('marketplace', 'migration')),
  source_preference_id       TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_newsletter_preferences_source
    UNIQUE (source_system, source_preference_id),
  CONSTRAINT chk_marketplace_newsletter_preferences_source_id
    CHECK (source_system = 'marketplace' OR source_preference_id IS NOT NULL)
);

CREATE INDEX idx_marketplace_newsletter_preferences_enabled
  ON marketplace.newsletter_preferences (enabled)
  WHERE enabled = TRUE;

CREATE TABLE marketplace.marketplace_listing_read_model (
  listing_id                 UUID        PRIMARY KEY,
  property_id                UUID        NOT NULL,
  public_id                  TEXT        NOT NULL,
  canonical_slug             TEXT        NOT NULL,
  display_name               TEXT        NOT NULL,
  listing_title              TEXT        NOT NULL,
  listing_summary            TEXT,
  accommodation_type         TEXT,
  visibility_status          TEXT        NOT NULL DEFAULT 'private'
                                  CHECK (visibility_status IN ('public', 'unlisted', 'private', 'disabled')),
  location                   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  image_urls                 TEXT[]      NOT NULL DEFAULT '{}',
  public_offering_summary    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  public_creator_requirements JSONB      NOT NULL DEFAULT '{}'::jsonb,
  source_freshness           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  projected_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_marketplace_listing_read_model_public_json
    CHECK (
      NOT marketplace.jsonb_has_marketplace_private_key(location)
      AND NOT marketplace.jsonb_has_marketplace_private_key(public_offering_summary)
      AND NOT marketplace.jsonb_has_marketplace_private_key(public_creator_requirements)
      AND NOT marketplace.jsonb_has_marketplace_private_key(source_freshness)
    ),
  CONSTRAINT fk_marketplace_read_model_listing_property
    FOREIGN KEY (listing_id, property_id)
    REFERENCES marketplace.marketplace_hotel_listings(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_marketplace_read_model_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_listing_read_model_visibility
  ON marketplace.marketplace_listing_read_model (visibility_status, projected_at DESC);
