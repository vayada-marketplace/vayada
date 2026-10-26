-- Fixture: media-url-migration / media.sql
-- Source: migration_source_media schema.
--
-- Represents the one-time existing URL migration inventory from Booking and
-- PMS source snapshots into the platform media registry and domain
-- reference/read-model fields.

DROP SCHEMA IF EXISTS migration_source_media CASCADE;
CREATE SCHEMA migration_source_media;

CREATE TABLE migration_source_media.users AS
SELECT
  'f8221000-0000-0000-0000-000000000001'::uuid AS id,
  'media.hotel.owner@example.test'::text AS email,
  'Media Hotel Owner'::text AS name,
  'active'::text AS status;

CREATE TABLE migration_source_media.organizations AS
SELECT
  'f8222000-0000-0000-0000-000000000001'::uuid AS id,
  'hotel_group'::text AS kind,
  'Media Migration Hotel Group'::text AS name,
  'media-migration-hotel-group'::text AS slug,
  'active'::text AS status;

CREATE TABLE migration_source_media.properties AS
SELECT
  'f8223000-0000-0000-0000-000000000001'::uuid AS id,
  'prop_media_migration'::text AS public_id,
  'Media Migration Hotel'::text AS display_name,
  'hotel'::text AS property_type,
  'boutique'::text AS category,
  'en'::text AS default_locale,
  ARRAY['en']::text[] AS supported_locales,
  'complete'::text AS profile_status;

CREATE TABLE migration_source_media.property_source_links AS
SELECT
  'f8223100-0000-0000-0000-000000000001'::uuid AS id,
  'f8223000-0000-0000-0000-000000000001'::uuid AS property_id,
  'booking'::text AS source_system,
  'booking_hotels'::text AS source_table,
  'booking-hotel-822'::text AS source_id,
  'canonical_input'::text AS relationship,
  '{"fixture": "media-url-migration"}'::jsonb AS metadata
UNION ALL
SELECT
  'f8223100-0000-0000-0000-000000000003'::uuid,
  'f8223000-0000-0000-0000-000000000001'::uuid,
  'pms'::text,
  'room_types'::text,
  'pms-room-type-822'::text,
  'operational_input'::text,
  '{"fixture": "media-url-migration"}'::jsonb;

CREATE TABLE migration_source_media.property_slugs AS
SELECT
  'f8223200-0000-0000-0000-000000000001'::uuid AS id,
  'f8223000-0000-0000-0000-000000000001'::uuid AS property_id,
  'media-migration-hotel'::text AS slug,
  'canonical'::text AS purpose,
  'active'::text AS status;

CREATE TABLE migration_source_media.pms_room_types AS
SELECT
  'f8227000-0000-0000-0000-000000000001'::uuid AS id,
  'f8223000-0000-0000-0000-000000000001'::uuid AS property_id,
  'pms-room-type-822'::text AS source_room_type_id,
  'Media Suite'::text AS name,
  'Room type used for PMS media migration parity.'::text AS description,
  'suite'::text AS category,
  '{"adults": 2, "children": 1}'::jsonb AS occupancy_limits,
  '{"beds": ["king"]}'::jsonb AS room_attributes,
  '["wifi"]'::jsonb AS amenities_snapshot,
  '[]'::jsonb AS media_snapshot,
  180.00::numeric AS base_rate_amount,
  'EUR'::char(3) AS currency,
  TRUE::boolean AS active,
  1::integer AS sort_order;

CREATE TABLE migration_source_media.pms_message_threads AS
SELECT
  'f8227100-0000-0000-0000-000000000001'::uuid AS id,
  'f8223000-0000-0000-0000-000000000001'::uuid AS property_id,
  'migration'::text AS source,
  'pms-thread-822'::text AS source_thread_id,
  'booking.com'::text AS channel,
  'open'::text AS status,
  0::integer AS unread_count;

CREATE TABLE migration_source_media.pms_messages AS
SELECT
  'f8227200-0000-0000-0000-000000000001'::uuid AS id,
  'f8223000-0000-0000-0000-000000000001'::uuid AS property_id,
  'f8227100-0000-0000-0000-000000000001'::uuid AS thread_id,
  'pms-message-822'::text AS source_message_id,
  'inbound'::text AS direction,
  'guest'::text AS sender_type,
  NULL::uuid AS sender_user_id,
  'Guest Example'::text AS sender_display_name,
  'Please see the attachments.'::text AS body,
  '2026-06-01T12:05:00Z'::timestamptz AS sent_at,
  '2026-06-01T12:05:30Z'::timestamptz AS received_at,
  '{"fixture": "media-url-migration"}'::jsonb AS raw_payload;

CREATE TABLE migration_source_media.pms_message_attachments AS
SELECT
  'f8227300-0000-0000-0000-000000000001'::uuid AS id,
  'f8223000-0000-0000-0000-000000000001'::uuid AS property_id,
  'f8227200-0000-0000-0000-000000000001'::uuid AS message_id,
  'legacy-pms-message-attachments/thread-822/invoice.pdf'::text AS s3_key,
  NULL::text AS source_url,
  'invoice.pdf'::text AS filename,
  'application/pdf'::text AS content_type,
  144000::integer AS size_bytes,
  'pms-attachment-822-s3'::text AS source_attachment_id
UNION ALL
SELECT
  'f8227300-0000-0000-0000-000000000002'::uuid,
  'f8223000-0000-0000-0000-000000000001'::uuid,
  'f8227200-0000-0000-0000-000000000001'::uuid,
  NULL::text,
  'https://provider.example.test/messages/thread-822/passport.png'::text,
  'passport.png'::text,
  'image/png'::text,
  98000::integer,
  'pms-attachment-822-external'::text;

CREATE TABLE migration_source_media.legacy_media_urls AS
SELECT *
FROM (
  VALUES
    (
      'f8224000-0000-0000-0000-000000000001'::uuid,
      'property.hero_image',
      'public',
      'vayada_managed',
      'booking',
      'booking_hotels',
      'booking-hotel-822:hero_image',
      'hero_image',
      'https://legacy-booking-media.s3.amazonaws.com/hotels/booking-hotel-822/hero.jpg',
      'legacy-booking-media',
      'hotels/booking-hotel-822/hero.jpg',
      'vayada-media-local',
      'public/properties/f8223000-0000-0000-0000-000000000001/f8224000-0000-0000-0000-000000000001/original_safe.webp',
      'image/webp',
      262144::bigint,
      'sha256:booking-hero-822',
      1920,
      1080,
      'booking-hero.jpg',
      'f8222000-0000-0000-0000-000000000001'::uuid,
      'f8223000-0000-0000-0000-000000000001'::uuid,
      'hotel_catalog',
      'property_media',
      'hero',
      TRUE,
      'f8221000-0000-0000-0000-000000000001'::uuid,
      '{"migrationRule": "booking public hero copied"}'::jsonb
    ),
    (
      'f8224000-0000-0000-0000-000000000002'::uuid,
      'property.gallery_image',
      'private',
      'external_reference',
      'booking',
      'booking_hotels',
      'booking-hotel-822:images:1',
      'images[0]',
      'https://external-images.example.test/booking/gallery-1.jpg',
      NULL,
      NULL,
      'vayada-media-local',
      NULL,
      'image/jpeg',
      NULL::bigint,
      NULL,
      NULL::integer,
      NULL::integer,
      'booking-gallery-1.jpg',
      'f8222000-0000-0000-0000-000000000001'::uuid,
      'f8223000-0000-0000-0000-000000000001'::uuid,
      'hotel_catalog',
      'property_media',
      'gallery-1',
      FALSE,
      'f8221000-0000-0000-0000-000000000001'::uuid,
      '{"migrationRule": "booking external gallery preserved"}'::jsonb
    ),
    (
      'f8224000-0000-0000-0000-000000000006'::uuid,
      'pms.room_type.media',
      'public',
      'vayada_managed',
      'pms',
      'room_types',
      'pms-room-type-822:images:1',
      'images[0]',
      'https://legacy-pms-media.s3.amazonaws.com/rooms/pms-room-type-822/room.jpg',
      'legacy-pms-media',
      'rooms/pms-room-type-822/room.jpg',
      'vayada-media-local',
      'public/properties/f8223000-0000-0000-0000-000000000001/f8224000-0000-0000-0000-000000000006/original_safe.webp',
      'image/webp',
      221184::bigint,
      'sha256:pms-room-822',
      1800,
      1200,
      'room.jpg',
      'f8222000-0000-0000-0000-000000000001'::uuid,
      'f8223000-0000-0000-0000-000000000001'::uuid,
      'pms',
      'room_type',
      'f8227000-0000-0000-0000-000000000001',
      TRUE,
      'f8221000-0000-0000-0000-000000000001'::uuid,
      '{"migrationRule": "pms public-approved room image copied"}'::jsonb
    ),
    (
      'f8224000-0000-0000-0000-000000000007'::uuid,
      'pms.import.source_image',
      'private',
      'external_reference',
      'pms',
      'room_image_imports',
      'pms-import-job-822:source:1',
      'source_url',
      'https://vendor-import.example.test/rooms/pms-room-type-822/source.jpg',
      NULL,
      NULL,
      'vayada-media-local',
      NULL,
      'image/jpeg',
      NULL::bigint,
      NULL,
      NULL::integer,
      NULL::integer,
      'source.jpg',
      'f8222000-0000-0000-0000-000000000001'::uuid,
      'f8223000-0000-0000-0000-000000000001'::uuid,
      'pms',
      'room_image_import',
      'pms-import-job-822',
      FALSE,
      'f8221000-0000-0000-0000-000000000001'::uuid,
      '{"migrationRule": "pms import source unresolved external"}'::jsonb
    ),
    (
      'f8224000-0000-0000-0000-000000000008'::uuid,
      'pms.messaging.attachment',
      'private',
      'vayada_managed',
      'pms',
      'message_attachments',
      'pms-attachment-822-s3',
      's3_key',
      'https://legacy-pms-private.s3.amazonaws.com/legacy-pms-message-attachments/thread-822/invoice.pdf',
      'legacy-pms-private',
      'legacy-pms-message-attachments/thread-822/invoice.pdf',
      'vayada-media-local',
      'private/pms/properties/f8223000-0000-0000-0000-000000000001/messages/f8227100-0000-0000-0000-000000000001/f8224000-0000-0000-0000-000000000008/invoice.pdf',
      'application/pdf',
      144000::bigint,
      'sha256:pms-attachment-822',
      NULL::integer,
      NULL::integer,
      'invoice.pdf',
      'f8222000-0000-0000-0000-000000000001'::uuid,
      'f8223000-0000-0000-0000-000000000001'::uuid,
      'pms',
      'message_attachment',
      'f8227300-0000-0000-0000-000000000001',
      FALSE,
      'f8221000-0000-0000-0000-000000000001'::uuid,
      '{"migrationRule": "pms private message attachment copied"}'::jsonb
    ),
    (
      'f8224000-0000-0000-0000-000000000009'::uuid,
      'pms.messaging.attachment',
      'private',
      'external_reference',
      'pms',
      'message_attachments',
      'pms-attachment-822-external',
      'source_url',
      'https://provider.example.test/messages/thread-822/passport.png',
      NULL,
      NULL,
      'vayada-media-local',
      NULL,
      'image/png',
      98000::bigint,
      NULL,
      NULL::integer,
      NULL::integer,
      'passport.png',
      'f8222000-0000-0000-0000-000000000001'::uuid,
      'f8223000-0000-0000-0000-000000000001'::uuid,
      'pms',
      'message_attachment',
      'f8227300-0000-0000-0000-000000000002',
      FALSE,
      'f8221000-0000-0000-0000-000000000001'::uuid,
      '{"migrationRule": "pms provider attachment preserved"}'::jsonb
    )
) AS media(
  media_object_id,
  purpose,
  visibility,
  storage_kind,
  source_system,
  source_table,
  source_row_id,
  source_field,
  source_url,
  legacy_bucket,
  legacy_key,
  platform_bucket,
  target_storage_key,
  content_type,
  size_bytes,
  checksum_sha256,
  width_px,
  height_px,
  original_filename,
  owner_organization_id,
  property_id,
  resource_product,
  resource_type,
  resource_id,
  public_approved,
  created_by_user_id,
  source_metadata
);

CREATE TABLE migration_source_media.media_variants (
  id UUID PRIMARY KEY,
  media_object_id UUID NOT NULL,
  variant_name TEXT NOT NULL,
  visibility TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  width_px INTEGER,
  height_px INTEGER,
  size_bytes BIGINT,
  checksum_sha256 TEXT,
  public_cdn_url TEXT
);

INSERT INTO migration_source_media.media_variants
SELECT
  ('f8224100-0000-0000-0000-' || lpad(((object_index - 1) * 4 + variant_index)::text, 12, '0'))::uuid AS id,
  media_object_id,
  variant_name,
  'public'::text AS visibility,
  regexp_replace(target_storage_key, 'original_safe\.webp$', variant_name || '.webp') AS storage_key,
  'image/webp'::text AS content_type,
  CASE variant_name
    WHEN 'original_safe' THEN width_px
    WHEN 'large' THEN LEAST(width_px, 1280)
    WHEN 'thumbnail' THEN 320
    ELSE 32
  END AS width_px,
  CASE variant_name
    WHEN 'original_safe' THEN height_px
    WHEN 'large' THEN LEAST(height_px, 720)
    WHEN 'thumbnail' THEN 180
    ELSE 18
  END AS height_px,
  CASE variant_name
    WHEN 'original_safe' THEN size_bytes
    WHEN 'large' THEN size_bytes / 2
    WHEN 'thumbnail' THEN size_bytes / 8
    ELSE 2048
  END AS size_bytes,
  checksum_sha256 || ':' || variant_name AS checksum_sha256,
  'https://media.localhost/' ||
    regexp_replace(
      regexp_replace(target_storage_key, 'original_safe\.webp$', variant_name || '.webp'),
      '^public/',
      'public-cdn/'
    ) AS public_cdn_url
FROM (
  SELECT
    media_object_id,
    target_storage_key,
    width_px,
    height_px,
    size_bytes,
    checksum_sha256,
    row_number() OVER (ORDER BY media_object_id) AS object_index
  FROM migration_source_media.legacy_media_urls
  WHERE visibility = 'public'
    AND storage_kind = 'vayada_managed'
) public_media
CROSS JOIN (
  VALUES
    (1, 'original_safe'),
    (2, 'large'),
    (3, 'thumbnail'),
    (4, 'blur_preview')
) AS variants(variant_index, variant_name);

INSERT INTO migration_source_media.media_variants
VALUES
  (
    'f8224100-0000-0000-0000-000000000018',
    'f8224000-0000-0000-0000-000000000008',
    'provider_original',
    'private',
    'private/pms/properties/f8223000-0000-0000-0000-000000000001/messages/f8227100-0000-0000-0000-000000000001/f8224000-0000-0000-0000-000000000008/invoice.pdf',
    'application/pdf',
    NULL,
    NULL,
    144000,
    'sha256:pms-attachment-822:provider_original',
    NULL
  );

CREATE TABLE migration_source_media.booking_property_media AS
SELECT
  'f8225000-0000-0000-0000-000000000001'::uuid AS id,
  'f8223000-0000-0000-0000-000000000001'::uuid AS property_id,
  'hero_image'::text AS media_type,
  'https://media.localhost/public-cdn/properties/f8223000-0000-0000-0000-000000000001/f8224000-0000-0000-0000-000000000001/original_safe.webp'::text AS url,
  'Media Migration Hotel hero'::text AS alt_text,
  0::integer AS sort_order,
  'booking'::text AS source_system,
  TRUE::boolean AS public_approved,
  '{"platformMediaObjectId": "f8224000-0000-0000-0000-000000000001"}'::jsonb AS rights_metadata,
  'f8224000-0000-0000-0000-000000000001'::uuid AS platform_media_object_id
UNION ALL
SELECT
  'f8225000-0000-0000-0000-000000000002'::uuid,
  'f8223000-0000-0000-0000-000000000001'::uuid,
  'gallery_image'::text,
  'https://external-images.example.test/booking/gallery-1.jpg'::text,
  'Media Migration Hotel gallery image'::text,
  1::integer,
  'booking'::text,
  TRUE::boolean,
  '{"platformMediaObjectId": "f8224000-0000-0000-0000-000000000002", "externalReference": true}'::jsonb,
  'f8224000-0000-0000-0000-000000000002'::uuid;

CREATE TABLE migration_source_media.pms_room_media_references AS
SELECT
  'f8227000-0000-0000-0000-000000000001'::uuid AS room_type_id,
  '[
    {
      "mediaObjectId": "f8224000-0000-0000-0000-000000000006",
      "url": "https://media.localhost/public-cdn/properties/f8223000-0000-0000-0000-000000000001/f8224000-0000-0000-0000-000000000006/original_safe.webp",
      "source": "pms",
      "sourceTable": "room_types",
      "publicApproved": true
    }
  ]'::jsonb AS target_media_snapshot;

CREATE TABLE migration_source_media.pms_attachment_references AS
SELECT
  'f8227300-0000-0000-0000-000000000001'::uuid AS attachment_id,
  'private/pms/properties/f8223000-0000-0000-0000-000000000001/messages/f8227100-0000-0000-0000-000000000001/f8224000-0000-0000-0000-000000000008/invoice.pdf'::text AS target_s3_key,
  'https://legacy-pms-private.s3.amazonaws.com/legacy-pms-message-attachments/thread-822/invoice.pdf'::text AS target_source_url,
  'f8224000-0000-0000-0000-000000000008'::uuid AS platform_media_object_id
UNION ALL
SELECT
  'f8227300-0000-0000-0000-000000000002'::uuid,
  NULL::text,
  'https://provider.example.test/messages/thread-822/passport.png'::text,
  'f8224000-0000-0000-0000-000000000009'::uuid;
