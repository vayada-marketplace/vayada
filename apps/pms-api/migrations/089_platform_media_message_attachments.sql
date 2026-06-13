CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.media_objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket TEXT,
    storage_key TEXT,
    storage_kind TEXT NOT NULL DEFAULT 'vayada_managed',
    visibility TEXT NOT NULL,
    purpose TEXT NOT NULL,
    property_id UUID,
    resource_product TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    lifecycle_status TEXT NOT NULL DEFAULT 'staged',
    content_type TEXT,
    size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
    checksum_sha256 TEXT,
    original_filename TEXT,
    source_url TEXT,
    source_system TEXT NOT NULL DEFAULT 'platform',
    source_table TEXT,
    source_row_id TEXT,
    source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    public_approved BOOLEAN NOT NULL DEFAULT false,
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.media_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    media_object_id UUID NOT NULL REFERENCES platform.media_objects(id) ON DELETE CASCADE,
    variant_name TEXT NOT NULL,
    visibility TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
    checksum_sha256 TEXT,
    public_cdn_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (media_object_id, variant_name)
);

ALTER TABLE message_attachments
    ADD COLUMN IF NOT EXISTS platform_media_object_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_message_attachments_platform_media'
    ) THEN
        ALTER TABLE message_attachments
            ADD CONSTRAINT fk_message_attachments_platform_media
            FOREIGN KEY (platform_media_object_id)
            REFERENCES platform.media_objects(id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_message_attachments_platform_media
    ON message_attachments (platform_media_object_id)
    WHERE platform_media_object_id IS NOT NULL;
