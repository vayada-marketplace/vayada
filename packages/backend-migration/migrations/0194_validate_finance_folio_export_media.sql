-- Migration: 0194_validate_finance_folio_export_media
-- Owner: platform-media, domain-finance / VAY-1134

ALTER TABLE platform.media_objects
  VALIDATE CONSTRAINT chk_platform_media_objects_finance;
