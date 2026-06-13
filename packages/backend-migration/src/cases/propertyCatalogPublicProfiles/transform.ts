import type pg from "pg";

export async function transformPropertyCatalogPublicProfiles(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO hotel_catalog.properties
      (id, public_id, display_name, property_type, category, default_locale, supported_locales, profile_status, completeness_reasons, created_at, updated_at)
    SELECT
      source.property_id,
      source.public_id,
      source.display_name,
      source.property_type,
      source.category,
      source.default_locale,
      source.supported_locales,
      source.profile_status,
      source.completeness_reasons,
      source.created_at,
      source.updated_at
    FROM migration_source_booking.property_catalog_inputs source
    ON CONFLICT (id) DO UPDATE SET
      public_id = EXCLUDED.public_id,
      display_name = EXCLUDED.display_name,
      property_type = EXCLUDED.property_type,
      category = EXCLUDED.category,
      default_locale = EXCLUDED.default_locale,
      supported_locales = EXCLUDED.supported_locales,
      profile_status = EXCLUDED.profile_status,
      completeness_reasons = EXCLUDED.completeness_reasons,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_source_links
      (property_id, source_system, source_table, source_id, relationship, metadata, created_at, updated_at)
    SELECT
      source.property_id,
      'booking',
      'booking_hotels',
      source.source_id,
      'canonical_input',
      source.metadata,
      source.created_at,
      source.updated_at
    FROM migration_source_booking.property_catalog_inputs source
    UNION ALL
    SELECT
      source.property_id,
      'pms',
      'hotels',
      source.source_id,
      'operational_input',
      source.metadata,
      source.created_at,
      source.updated_at
    FROM migration_source_pms.property_catalog_inputs source
    UNION ALL
    SELECT
      source.property_id,
      'marketplace',
      source.source_table,
      source.source_id,
      source.relationship,
      source.metadata,
      source.created_at,
      source.updated_at
    FROM migration_source_marketplace.property_catalog_inputs source
    ON CONFLICT (source_system, source_table, source_id) DO UPDATE SET
      property_id = EXCLUDED.property_id,
      relationship = EXCLUDED.relationship,
      metadata = EXCLUDED.metadata,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_slugs
      (id, property_id, slug, locale, purpose, status, redirects_to_id, created_at, updated_at)
    SELECT
      source.canonical_slug_id,
      source.property_id,
      source.canonical_slug,
      NULL,
      'canonical',
      'active',
      NULL,
      source.created_at,
      source.updated_at
    FROM migration_source_booking.property_catalog_inputs source
    ON CONFLICT (slug, COALESCE(locale, '')) DO UPDATE SET
      property_id = EXCLUDED.property_id,
      purpose = EXCLUDED.purpose,
      status = EXCLUDED.status,
      redirects_to_id = EXCLUDED.redirects_to_id,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_slugs
      (id, property_id, slug, locale, purpose, status, redirects_to_id, created_at, updated_at)
    SELECT
      redirect.id,
      source.property_id,
      redirect.slug,
      NULL,
      'redirect',
      'redirected',
      source.canonical_slug_id,
      source.created_at,
      source.updated_at
    FROM migration_source_booking.property_catalog_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.redirect_slugs)
      AS redirect(id uuid, slug text)
    ON CONFLICT (slug, COALESCE(locale, '')) DO UPDATE SET
      property_id = EXCLUDED.property_id,
      purpose = EXCLUDED.purpose,
      status = EXCLUDED.status,
      redirects_to_id = EXCLUDED.redirects_to_id,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_domains
      (id, property_id, hostname, verification_status, canonical_when_verified, verified_at, created_at, updated_at)
    SELECT
      source.custom_domain_id,
      source.property_id,
      source.custom_domain_hostname,
      source.domain_verification_status,
      source.canonical_when_verified,
      source.domain_verified_at,
      source.created_at,
      source.updated_at
    FROM migration_source_booking.property_catalog_inputs source
    WHERE source.custom_domain_id IS NOT NULL
    ON CONFLICT (id) DO UPDATE SET
      property_id = EXCLUDED.property_id,
      hostname = EXCLUDED.hostname,
      verification_status = EXCLUDED.verification_status,
      canonical_when_verified = EXCLUDED.canonical_when_verified,
      verified_at = EXCLUDED.verified_at,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_locations
      (
        property_id,
        country_code,
        region,
        city,
        street_address,
        postal_code,
        raw_marketplace_location,
        latitude,
        longitude,
        timezone,
        address_public,
        geo_public,
        map_display_mode,
        source_confidence,
        migration_notes,
        updated_at
      )
    SELECT
      booking.property_id,
      booking.country_code,
      booking.region,
      booking.city,
      booking.street_address,
      booking.postal_code,
      marketplace.raw_location,
      booking.latitude,
      booking.longitude,
      COALESCE(pms.timezone, booking.timezone),
      booking.address_public,
      booking.geo_public,
      booking.map_display_mode,
      booking.location_source_confidence,
      CASE
        WHEN booking.country_code IS NULL AND marketplace.raw_location IS NOT NULL
          THEN 'Marketplace free-form location preserved for manual reconciliation.'
        ELSE NULL
      END,
      GREATEST(booking.updated_at, COALESCE(marketplace.updated_at, booking.updated_at))
    FROM migration_source_booking.property_catalog_inputs booking
    LEFT JOIN migration_source_pms.property_catalog_inputs pms
      ON pms.property_id = booking.property_id
    LEFT JOIN migration_source_marketplace.property_catalog_inputs marketplace
      ON marketplace.property_id = booking.property_id
    ON CONFLICT (property_id) DO UPDATE SET
      country_code = EXCLUDED.country_code,
      region = EXCLUDED.region,
      city = EXCLUDED.city,
      street_address = EXCLUDED.street_address,
      postal_code = EXCLUDED.postal_code,
      raw_marketplace_location = EXCLUDED.raw_marketplace_location,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      timezone = EXCLUDED.timezone,
      address_public = EXCLUDED.address_public,
      geo_public = EXCLUDED.geo_public,
      map_display_mode = EXCLUDED.map_display_mode,
      source_confidence = EXCLUDED.source_confidence,
      migration_notes = EXCLUDED.migration_notes,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_profiles
      (property_id, locale, short_description, long_description, source_confidence, created_at, updated_at)
    SELECT
      source.property_id,
      source.locale,
      source.short_description,
      source.long_description,
      source.profile_source_confidence,
      source.created_at,
      source.updated_at
    FROM migration_source_marketplace.property_catalog_inputs source
    ON CONFLICT (property_id, locale) DO UPDATE SET
      short_description = EXCLUDED.short_description,
      long_description = EXCLUDED.long_description,
      source_confidence = EXCLUDED.source_confidence,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_media
      (
        id,
        property_id,
        media_type,
        url,
        alt_text,
        sort_order,
        source_system,
        public_approved,
        platform_media_object_id,
        created_at,
        updated_at
      )
    SELECT
      media.id,
      source.property_id,
      media.media_type,
      media.url,
      media.alt_text,
      media.sort_order,
      'booking',
      media.public_approved,
      media.platform_media_object_id,
      source.created_at,
      source.updated_at
    FROM migration_source_booking.property_catalog_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.media)
      AS media(
        id uuid,
        media_type text,
        url text,
        alt_text text,
        sort_order integer,
        public_approved boolean,
        platform_media_object_id uuid
      )
    UNION ALL
    SELECT
      media.id,
      source.property_id,
      media.media_type,
      media.url,
      media.alt_text,
      media.sort_order,
      'marketplace',
      media.public_approved,
      media.platform_media_object_id,
      source.created_at,
      source.updated_at
    FROM migration_source_marketplace.property_catalog_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.media)
      AS media(
        id uuid,
        media_type text,
        url text,
        alt_text text,
        sort_order integer,
        public_approved boolean,
        platform_media_object_id uuid
      )
    ON CONFLICT (id) DO UPDATE SET
      property_id = EXCLUDED.property_id,
      media_type = EXCLUDED.media_type,
      url = EXCLUDED.url,
      alt_text = EXCLUDED.alt_text,
      sort_order = EXCLUDED.sort_order,
      source_system = EXCLUDED.source_system,
      public_approved = EXCLUDED.public_approved,
      platform_media_object_id = EXCLUDED.platform_media_object_id,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_amenities
      (property_id, amenity_key, label, source_system, public_safe, created_at, updated_at)
    SELECT source.property_id, amenity.amenity_key, amenity.label, 'booking', amenity.public_safe, source.created_at, source.updated_at
    FROM migration_source_booking.property_catalog_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.amenities)
      AS amenity(amenity_key text, label text, public_safe boolean)
    UNION ALL
    SELECT source.property_id, amenity.amenity_key, amenity.label, 'pms', amenity.public_safe, source.created_at, source.updated_at
    FROM migration_source_pms.property_catalog_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.amenities)
      AS amenity(amenity_key text, label text, public_safe boolean)
    UNION ALL
    SELECT source.property_id, amenity.amenity_key, amenity.label, 'marketplace', amenity.public_safe, source.created_at, source.updated_at
    FROM migration_source_marketplace.property_catalog_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.amenities)
      AS amenity(amenity_key text, label text, public_safe boolean)
    ON CONFLICT (property_id, amenity_key) DO UPDATE SET
      label = EXCLUDED.label,
      source_system = EXCLUDED.source_system,
      public_safe = EXCLUDED.public_safe,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_contact_channels
      (property_id, channel_type, value, is_public, source_system, created_at, updated_at)
    SELECT
      source.property_id,
      contact.channel_type,
      contact.value,
      contact.is_public,
      'booking',
      source.created_at,
      source.updated_at
    FROM migration_source_booking.property_catalog_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.public_contacts)
      AS contact(channel_type text, value text, is_public boolean)
    ON CONFLICT (property_id, channel_type, value) DO UPDATE SET
      is_public = EXCLUDED.is_public,
      source_system = EXCLUDED.source_system,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_policy_summaries
      (
        property_id,
        check_in_time,
        check_out_time,
        cancellation_summary,
        cancellation_terms_url,
        deposit_policy_summary,
        payment_policy_summary,
        policy_source_owner,
        updated_at
      )
    SELECT
      source.property_id,
      (source.policy ->> 'checkInTime')::time,
      (source.policy ->> 'checkOutTime')::time,
      source.policy ->> 'cancellationSummary',
      source.policy ->> 'cancellationTermsUrl',
      source.policy ->> 'depositPolicySummary',
      source.policy ->> 'paymentPolicySummary',
      'booking',
      source.updated_at
    FROM migration_source_booking.property_catalog_inputs source
    ON CONFLICT (property_id) DO UPDATE SET
      check_in_time = EXCLUDED.check_in_time,
      check_out_time = EXCLUDED.check_out_time,
      cancellation_summary = EXCLUDED.cancellation_summary,
      cancellation_terms_url = EXCLUDED.cancellation_terms_url,
      deposit_policy_summary = EXCLUDED.deposit_policy_summary,
      payment_policy_summary = EXCLUDED.payment_policy_summary,
      policy_source_owner = EXCLUDED.policy_source_owner,
      updated_at = EXCLUDED.updated_at
  `);

  await client.query(`
    WITH canonical_slugs AS (
      SELECT property_id, slug
      FROM hotel_catalog.property_slugs
      WHERE purpose = 'canonical' AND status = 'active'
    ),
    verified_domains AS (
      SELECT id, property_id, hostname
      FROM hotel_catalog.property_domains
      WHERE verification_status = 'verified' AND canonical_when_verified = TRUE
    ),
    descriptions AS (
      SELECT
        property_id,
        jsonb_object_agg(
          locale,
          jsonb_strip_nulls(jsonb_build_object('short', short_description, 'long', long_description))
        ) AS descriptions
      FROM hotel_catalog.property_profiles
      GROUP BY property_id
    ),
    media AS (
      SELECT
        property_media.property_id,
        jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'id', property_media.id::text,
            'type', property_media.media_type,
            'url', variant.public_cdn_url,
            'altText', property_media.alt_text,
            'sortOrder', property_media.sort_order,
            'platformMediaObjectId', property_media.platform_media_object_id::text
          ))
          ORDER BY property_media.sort_order, property_media.id
        ) FILTER (WHERE property_media.public_approved) AS media
      FROM hotel_catalog.property_media property_media
      JOIN platform.media_objects media_object
        ON media_object.id = property_media.platform_media_object_id
       AND media_object.visibility = 'public'
       AND media_object.public_approved = TRUE
       AND media_object.lifecycle_status = 'active'
      JOIN platform.media_variants variant
        ON variant.media_object_id = media_object.id
       AND variant.visibility = 'public'
       AND variant.variant_name = 'original_safe'
      WHERE property_media.public_approved = TRUE
      GROUP BY property_media.property_id
    ),
    amenities AS (
      SELECT
        property_id,
        jsonb_agg(
          jsonb_build_object('key', amenity_key, 'label', label)
          ORDER BY amenity_key
        ) FILTER (WHERE public_safe) AS amenities
      FROM hotel_catalog.property_amenities
      GROUP BY property_id
    ),
    contacts AS (
      SELECT
        property_id,
        jsonb_agg(
          jsonb_build_object('type', channel_type, 'value', value)
          ORDER BY channel_type, value
        ) FILTER (WHERE is_public) AS public_contacts
      FROM hotel_catalog.property_contact_channels
      GROUP BY property_id
    ),
    policies AS (
      SELECT
        property_id,
        jsonb_strip_nulls(jsonb_build_object(
          'checkInTime', CASE WHEN check_in_time IS NULL THEN NULL ELSE to_char(check_in_time, 'HH24:MI') END,
          'checkOutTime', CASE WHEN check_out_time IS NULL THEN NULL ELSE to_char(check_out_time, 'HH24:MI') END
        )) AS public_policy
      FROM hotel_catalog.property_policy_summaries
    )
    INSERT INTO hotel_catalog.property_public_profile_read_model
      (
        property_id,
        public_id,
        display_name,
        canonical_slug,
        property_domain_id,
        verified_custom_domain,
        default_locale,
        supported_locales,
        profile_status,
        completeness_reasons,
        location,
        descriptions,
        media,
        amenities,
        public_contacts,
        public_policy,
        source_freshness
      )
    SELECT
      property.id,
      property.public_id,
      property.display_name,
      canonical_slugs.slug,
      verified_domains.id,
      verified_domains.hostname,
      property.default_locale,
      property.supported_locales,
      property.profile_status,
      property.completeness_reasons,
      CASE
        WHEN location.country_code IS NOT NULL
          OR location.city IS NOT NULL
          OR location.timezone IS NOT NULL
          OR location.latitude IS NOT NULL
          THEN jsonb_strip_nulls(jsonb_build_object(
            'countryCode', location.country_code,
            'city', location.city,
            'timezone', location.timezone,
            'geo', CASE
              WHEN location.latitude IS NOT NULL AND location.longitude IS NOT NULL
                THEN jsonb_build_object(
                  'latitude', location.latitude::double precision,
                  'longitude', location.longitude::double precision
                )
              ELSE NULL
            END
          ))
        WHEN location.raw_marketplace_location IS NOT NULL
          THEN jsonb_build_object('rawMarketplaceLocation', location.raw_marketplace_location)
        ELSE '{}'::jsonb
      END,
      COALESCE(descriptions.descriptions, '{}'::jsonb),
      COALESCE(media.media, '[]'::jsonb),
      COALESCE(amenities.amenities, '[]'::jsonb),
      COALESCE(contacts.public_contacts, '[]'::jsonb),
      COALESCE(policies.public_policy, '{}'::jsonb),
      CASE
        WHEN property.profile_status = 'complete'
          THEN '{"hotel_catalog": {"status": "fresh"}, "booking": {"status": "fresh"}, "pms": {"status": "fresh"}, "marketplace": {"status": "fresh"}}'::jsonb
        ELSE '{"hotel_catalog": {"status": "stale"}, "marketplace": {"status": "fresh"}}'::jsonb
      END
    FROM hotel_catalog.properties property
    JOIN canonical_slugs ON canonical_slugs.property_id = property.id
    LEFT JOIN verified_domains ON verified_domains.property_id = property.id
    LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
    LEFT JOIN descriptions ON descriptions.property_id = property.id
    LEFT JOIN media ON media.property_id = property.id
    LEFT JOIN amenities ON amenities.property_id = property.id
    LEFT JOIN contacts ON contacts.property_id = property.id
    LEFT JOIN policies ON policies.property_id = property.id
    ON CONFLICT (property_id) DO UPDATE SET
      public_id = EXCLUDED.public_id,
      display_name = EXCLUDED.display_name,
      canonical_slug = EXCLUDED.canonical_slug,
      property_domain_id = EXCLUDED.property_domain_id,
      verified_custom_domain = EXCLUDED.verified_custom_domain,
      default_locale = EXCLUDED.default_locale,
      supported_locales = EXCLUDED.supported_locales,
      profile_status = EXCLUDED.profile_status,
      completeness_reasons = EXCLUDED.completeness_reasons,
      location = EXCLUDED.location,
      descriptions = EXCLUDED.descriptions,
      media = EXCLUDED.media,
      amenities = EXCLUDED.amenities,
      public_contacts = EXCLUDED.public_contacts,
      public_policy = EXCLUDED.public_policy,
      source_freshness = EXCLUDED.source_freshness,
      projected_at = now()
  `);
}
