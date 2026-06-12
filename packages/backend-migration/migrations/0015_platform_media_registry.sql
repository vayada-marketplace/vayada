-- Migration: 0015_platform_media_registry
-- Owner: platform-media
-- See: engineering/platform-media-decision.md,
--      engineering/target-schema-ownership-map.md,
--      engineering/migration-parity-harness.md
--
-- Creates the platform media registry target tables. Product domains own the
-- business references to media; platform owns object storage keys, lifecycle,
-- upload sessions, variants, and source URL migration audit state.

CREATE SCHEMA IF NOT EXISTS platform;

CREATE FUNCTION platform.valid_media_purpose_visibility(
  media_purpose TEXT,
  media_visibility TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN media_purpose IN (
      'property.hero_image',
      'property.gallery_image',
      'property.logo',
      'marketplace.listing.gallery',
      'marketplace.creator.profile_image',
      'pms.room_type.media'
    ) THEN media_visibility IN ('public', 'private')
    WHEN media_purpose IN (
      'marketplace.collaboration_chat.attachment',
      'pms.messaging.attachment',
      'pms.import.source_image'
    ) THEN media_visibility = 'private'
    ELSE FALSE
  END;
$$;

CREATE TABLE platform.media_objects (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket                TEXT,
  storage_key           TEXT,
  storage_kind          TEXT        NOT NULL DEFAULT 'vayada_managed'
                                      CHECK (storage_kind IN (
                                        'vayada_managed', 'external_reference'
                                      )),
  visibility            TEXT        NOT NULL
                                      CHECK (visibility IN ('public', 'private')),
  purpose               TEXT        NOT NULL,
  owner_organization_id UUID,
  property_id           UUID,
  resource_product      TEXT        NOT NULL
                                      CHECK (resource_product IN (
                                        'hotel_catalog', 'booking', 'pms',
                                        'marketplace', 'distribution',
                                        'platform', 'migration'
                                      )),
  resource_type         TEXT        NOT NULL,
  resource_id           TEXT,
  lifecycle_status      TEXT        NOT NULL DEFAULT 'staged'
                                      CHECK (lifecycle_status IN (
                                        'upload_pending', 'staged', 'validating',
                                        'processing', 'active', 'external_reference',
                                        'quarantined', 'rejected', 'delete_requested',
                                        'deleted', 'retained'
                                      )),
  content_type          TEXT,
  size_bytes            BIGINT      CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256       TEXT,
  width_px              INTEGER     CHECK (width_px IS NULL OR width_px > 0),
  height_px             INTEGER     CHECK (height_px IS NULL OR height_px > 0),
  original_filename     TEXT,
  source_url            TEXT,
  source_system         TEXT        NOT NULL DEFAULT 'platform'
                                      CHECK (source_system IN (
                                        'booking', 'pms', 'marketplace',
                                        'platform', 'migration', 'external'
                                      )),
  source_table          TEXT,
  source_row_id         TEXT,
  source_metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  public_approved       BOOLEAN     NOT NULL DEFAULT FALSE,
  retained_until        TIMESTAMPTZ,
  deletion_requested_at TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ,
  created_by_user_id    UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_platform_media_objects_id_visibility
    UNIQUE (id, visibility),
  CONSTRAINT uq_platform_media_objects_source
    UNIQUE (source_system, source_table, source_row_id, purpose),
  CONSTRAINT chk_platform_media_objects_purpose_visibility
    CHECK (platform.valid_media_purpose_visibility(purpose, visibility)),
  CONSTRAINT chk_platform_media_objects_storage_reference
    CHECK (
      (
        storage_kind = 'external_reference'
        AND bucket IS NULL
        AND storage_key IS NULL
        AND source_url IS NOT NULL
        AND lifecycle_status = 'external_reference'
      )
      OR
      (
        storage_kind = 'vayada_managed'
        AND bucket IS NOT NULL
        AND storage_key IS NOT NULL
        AND lifecycle_status <> 'external_reference'
      )
    ),
  CONSTRAINT chk_platform_media_objects_public_active
    CHECK (visibility <> 'public' OR (public_approved = TRUE AND lifecycle_status = 'active')),
  CONSTRAINT chk_platform_media_objects_source_pair
    CHECK (
      (source_table IS NULL AND source_row_id IS NULL)
      OR
      (source_table IS NOT NULL AND source_row_id IS NOT NULL)
    ),
  CONSTRAINT chk_platform_media_objects_delete_state
    CHECK (
      (lifecycle_status = 'delete_requested' AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL)
      OR
      (lifecycle_status = 'deleted' AND deleted_at IS NOT NULL)
      OR
      (lifecycle_status NOT IN ('delete_requested', 'deleted'))
    ),
  CONSTRAINT fk_platform_media_objects_owner_organization
    FOREIGN KEY (owner_organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_platform_media_objects_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id),
  CONSTRAINT fk_platform_media_objects_actor
    FOREIGN KEY (created_by_user_id)
    REFERENCES identity.users(id)
);

CREATE INDEX idx_platform_media_objects_property_purpose
  ON platform.media_objects (property_id, purpose, lifecycle_status);

CREATE INDEX idx_platform_media_objects_resource
  ON platform.media_objects (resource_product, resource_type, resource_id);

CREATE INDEX idx_platform_media_objects_source_url
  ON platform.media_objects (source_system, source_table, source_row_id)
  WHERE source_url IS NOT NULL;

CREATE TABLE platform.media_variants (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  media_object_id UUID        NOT NULL,
  variant_name    TEXT        NOT NULL
                              CHECK (variant_name IN (
                                'original_safe', 'large', 'thumbnail',
                                'blur_preview', 'provider_original'
                              )),
  visibility      TEXT        NOT NULL
                              CHECK (visibility IN ('public', 'private')),
  storage_key     TEXT        NOT NULL,
  content_type    TEXT        NOT NULL,
  width_px        INTEGER     CHECK (width_px IS NULL OR width_px > 0),
  height_px       INTEGER     CHECK (height_px IS NULL OR height_px > 0),
  size_bytes      BIGINT      CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 TEXT,
  public_cdn_url  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_platform_media_variants_object_name
    UNIQUE (media_object_id, variant_name),
  CONSTRAINT chk_platform_media_variants_public_url
    CHECK (
      (visibility = 'public' AND public_cdn_url IS NOT NULL AND public_cdn_url LIKE 'https://%')
      OR
      (visibility = 'private' AND public_cdn_url IS NULL)
    ),
  CONSTRAINT fk_platform_media_variants_object_visibility
    FOREIGN KEY (media_object_id, visibility)
    REFERENCES platform.media_objects(id, visibility)
    ON DELETE CASCADE
);

CREATE INDEX idx_platform_media_variants_object
  ON platform.media_variants (media_object_id);

CREATE TABLE platform.media_upload_sessions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_session_key    TEXT        NOT NULL UNIQUE,
  requested_purpose     TEXT        NOT NULL,
  requested_visibility  TEXT        NOT NULL
                                      CHECK (requested_visibility IN ('public', 'private')),
  actor_user_id         UUID,
  owner_organization_id UUID,
  property_id           UUID,
  resource_product      TEXT        NOT NULL
                                      CHECK (resource_product IN (
                                        'hotel_catalog', 'booking', 'pms',
                                        'marketplace', 'distribution',
                                        'platform', 'migration'
                                      )),
  resource_type         TEXT        NOT NULL,
  resource_id           TEXT,
  expected_content_type TEXT,
  expected_size_bytes   BIGINT      CHECK (
                                      expected_size_bytes IS NULL
                                      OR expected_size_bytes BETWEEN 1 AND 26214400
                                    ),
  expected_file_count   INTEGER     NOT NULL DEFAULT 1
                                      CHECK (expected_file_count BETWEEN 1 AND 25),
  staging_prefix        TEXT        NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  session_status        TEXT        NOT NULL DEFAULT 'requested'
                                      CHECK (session_status IN (
                                        'requested', 'signed', 'uploaded',
                                        'finalizing', 'completed',
                                        'expired', 'canceled', 'failed'
                                      )),
  completed_media_object_id UUID,
  completion_metadata   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  CONSTRAINT chk_platform_media_upload_sessions_purpose_visibility
    CHECK (platform.valid_media_purpose_visibility(requested_purpose, requested_visibility)),
  CONSTRAINT chk_platform_media_upload_sessions_terminal_time
    CHECK (
      session_status <> 'completed'
      OR (completed_at IS NOT NULL AND completed_media_object_id IS NOT NULL)
    ),
  CONSTRAINT chk_platform_media_upload_sessions_staging_prefix
    CHECK (staging_prefix LIKE 'staging/%'),
  CONSTRAINT fk_platform_media_upload_sessions_actor
    FOREIGN KEY (actor_user_id)
    REFERENCES identity.users(id),
  CONSTRAINT fk_platform_media_upload_sessions_owner_organization
    FOREIGN KEY (owner_organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_platform_media_upload_sessions_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id),
  CONSTRAINT fk_platform_media_upload_sessions_media_object
    FOREIGN KEY (completed_media_object_id)
    REFERENCES platform.media_objects(id)
);

CREATE INDEX idx_platform_media_upload_sessions_actor_status
  ON platform.media_upload_sessions (actor_user_id, session_status, expires_at);

CREATE INDEX idx_platform_media_upload_sessions_resource
  ON platform.media_upload_sessions (resource_product, resource_type, resource_id);
