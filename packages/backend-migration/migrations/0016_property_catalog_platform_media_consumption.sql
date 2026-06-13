-- Migration: 0016_property_catalog_platform_media_consumption
-- Owner: hotel-catalog / platform-media
-- See: engineering/platform-media-decision.md
--
-- Links public property catalog media metadata to platform media objects after
-- the platform registry exists. Product tables keep presentation ownership;
-- platform.media_objects remains authoritative for object lifecycle/variants.

ALTER TABLE hotel_catalog.property_media
  ADD COLUMN platform_media_object_id UUID;

ALTER TABLE hotel_catalog.property_media
  ADD CONSTRAINT fk_property_media_platform_media_object
  FOREIGN KEY (platform_media_object_id)
  REFERENCES platform.media_objects(id);

CREATE INDEX idx_property_media_platform_media_object
  ON hotel_catalog.property_media (platform_media_object_id)
  WHERE platform_media_object_id IS NOT NULL;
