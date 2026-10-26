/**
 * VAY-2247: what a hotel needed before the old setup's saves made it live (VAY-2140), kept for those
 * saves: a description in the default locale and an approved public image (a hotel photo or the logo).
 * Only the end of the first run activates on the basics alone. SQL over a `property` row.
 */
export const SETUP_GO_LIVE_CONTENT_SQL = `(
  EXISTS (
    SELECT 1
    FROM hotel_catalog.property_profiles profile
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
)`;
