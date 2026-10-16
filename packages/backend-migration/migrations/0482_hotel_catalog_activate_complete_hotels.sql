-- VAY-2140: a hotel no longer waits for Vayada to press "Activate". From the release that
-- ships this migration, setup activates a provisioning hotel when it completes its profile
-- (application side). This activates the provisioning hotels that are complete by those same
-- rules today: a description in the default locale and an approved public platform photo.
-- Stored status flags alone are not trusted (legacy imports wrote them by other rules).
-- Run it after that API is live, so no hotel completes in between. Suspended, retired,
-- disabled and private hotels never change. Running it again finds nothing.
SET LOCAL lock_timeout = '5s';

WITH activated AS (
  UPDATE hotel_catalog.properties property
  SET lifecycle_status = 'active',
      lifecycle_revision = property.lifecycle_revision + 1,
      profile_status = 'complete',
      completeness_reasons = '{}',
      updated_at = now()
  WHERE property.lifecycle_status = 'provisioning'
    AND property.profile_status NOT IN ('disabled', 'private')
    AND EXISTS (
      SELECT 1 FROM hotel_catalog.property_profiles profile
      WHERE profile.property_id = property.id
        AND profile.locale = property.default_locale
        AND COALESCE(
          NULLIF(BTRIM(profile.short_description), ''),
          NULLIF(BTRIM(profile.long_description), '')
        ) IS NOT NULL
    )
    AND EXISTS (
      SELECT 1
      FROM hotel_catalog.property_media media
      JOIN platform.media_objects media_object
        ON media_object.id = media.platform_media_object_id
       AND media_object.property_id = media.property_id
       AND media_object.visibility = 'public'
       AND media_object.public_approved = TRUE
       AND media_object.lifecycle_status = 'active'
      JOIN platform.media_variants variant
        ON variant.media_object_id = media_object.id
       AND variant.variant_name = 'original_safe'
       AND variant.visibility = 'public'
       AND NULLIF(variant.public_cdn_url, '') IS NOT NULL
      WHERE media.property_id = property.id
        AND media.public_approved = TRUE
        AND media.source_system = 'platform'
    )
  RETURNING property.id, property.lifecycle_revision
)
INSERT INTO platform.product_audit_events (
  audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
  target_resource_product, target_resource_type, target_resource_id,
  redacted_payload, audit_metadata, privacy_scope
)
SELECT 'hotel-catalog-auto-activate:' || activated.id::text || ':' || activated.lifecycle_revision,
       'hotel_catalog', 'hotel_catalog.property.lifecycle.auto_activate', now(), 'property',
       activated.id, 'migration', 'hotel_catalog', 'property', activated.id::text,
       jsonb_build_object('status', 'active', 'revision', activated.lifecycle_revision),
       '{"reason":"setup_profile_complete","migration":"0482"}'::jsonb, 'confidential'
FROM activated;
