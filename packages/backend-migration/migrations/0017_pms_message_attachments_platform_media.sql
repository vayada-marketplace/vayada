-- Migration: 0017_pms_message_attachments_platform_media
-- Owner: pms/platform-media
-- See: engineering/platform-media-decision.md VAY-827

ALTER TABLE pms.message_attachments
  ADD COLUMN IF NOT EXISTS platform_media_object_id UUID;

ALTER TABLE pms.message_attachments
  ADD CONSTRAINT fk_pms_message_attachments_platform_media
  FOREIGN KEY (platform_media_object_id)
  REFERENCES platform.media_objects(id);

CREATE INDEX idx_pms_message_attachments_platform_media
  ON pms.message_attachments (platform_media_object_id)
  WHERE platform_media_object_id IS NOT NULL;
