-- VAY-965: internal projection for the profile-edit writer. The body is the exact
-- 0469 Catalog/Marketplace projection without the logo assignment preamble; it has
-- no EXECUTE grant and is reachable only from the fixed 0472 definer writer.
CREATE FUNCTION platform.hotel_setup_sync_property_read_models(requested_property_id UUID)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $profile_projection$
DECLARE property_row RECORD; selected_offer_id UUID;
  slug_base TEXT; slug_suffix TEXT; candidate TEXT; reserved_slug TEXT;
BEGIN
  SELECT property.id, property.public_id, property.display_name INTO property_row
    FROM hotel_catalog.properties property WHERE property.id=requested_property_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hotel setup profile property missing' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hotel_catalog.property_slugs slug
    WHERE slug.property_id=requested_property_id AND slug.purpose='canonical' AND slug.status='active') THEN
    -- Same NFKD/ASCII slug and two-candidate reservation contract as ensureCanonicalPropertySlug.
    slug_base := rtrim(left(trim(both '-' from regexp_replace(lower(regexp_replace(
      pg_catalog.normalize(property_row.display_name, 'NFKD'), '[̀-ͯ]', '', 'g')), '[^a-z0-9]+', '-', 'g')), 63), '-');
    slug_suffix := rtrim(left(trim(both '-' from regexp_replace(lower(regexp_replace(
      pg_catalog.normalize(property_row.public_id, 'NFKD'), '[̀-ͯ]', '', 'g')), '[^a-z0-9]+', '-', 'g')), 63), '-');
    slug_base := coalesce(nullif(slug_base,''),nullif(slug_suffix,''),'hotel');
    slug_suffix := coalesce(nullif(right(slug_suffix,12),''),left(replace(requested_property_id::text,'-',''),12));
    slug_suffix := coalesce(nullif(trim(both '-' from left(slug_suffix,12)),''),'property');
    FOREACH candidate IN ARRAY ARRAY[slug_base, rtrim(left(slug_base, greatest(1,63-length(slug_suffix)-1)),'-') || '-' || slug_suffix] LOOP
      INSERT INTO hotel_catalog.property_slugs(property_id,slug,locale,purpose,status,updated_at)
        VALUES(requested_property_id,candidate,NULL,'canonical','active',now())
        ON CONFLICT DO NOTHING RETURNING slug INTO reserved_slug;
      IF reserved_slug IS NOT NULL THEN EXIT; END IF;
    END LOOP;
    IF reserved_slug IS NULL THEN RAISE EXCEPTION 'hotel setup profile canonical slug unavailable'; END IF;
  END IF;
WITH canonical_slug AS (
    SELECT slug.id, slug.property_id, slug.slug
    FROM hotel_catalog.property_slugs slug
    WHERE slug.property_id = requested_property_id
      AND slug.purpose = 'canonical'
      AND slug.status = 'active'
    LIMIT 1
  ),
  verified_domain AS (
    SELECT domain.id, domain.property_id, domain.hostname
    FROM hotel_catalog.property_domains domain
    WHERE domain.property_id = requested_property_id
      AND domain.verification_status = 'verified'
      AND domain.canonical_when_verified = TRUE
    ORDER BY domain.verified_at DESC NULLS LAST, domain.id
    LIMIT 1
  ),
  descriptions AS (
    SELECT
      profile.property_id,
      jsonb_object_agg(
        profile.locale,
        jsonb_strip_nulls(jsonb_build_object(
          'short', profile.short_description,
          'long', profile.long_description
        ))
      ) AS descriptions
    FROM hotel_catalog.property_profiles profile
    WHERE profile.property_id = requested_property_id
    GROUP BY profile.property_id
  ),
  approved_media AS (
    SELECT
      media.property_id,
      jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'id', media.id::text,
          'type', media.media_type,
          'url', media.url,
          'altText', media.alt_text,
          'sortOrder', media.sort_order,
          'platformMediaObjectId', media.platform_media_object_id::text
        ))
        ORDER BY
          CASE media.media_type WHEN 'logo' THEN 0 WHEN 'hero_image' THEN 1 ELSE 2 END,
          media.sort_order,
          media.id
      ) AS media
    FROM (
      SELECT
        candidate.id,
        candidate.property_id,
        candidate.media_type,
        media_variant.public_cdn_url AS url,
        candidate.alt_text,
        candidate.sort_order,
        candidate.platform_media_object_id
      FROM hotel_catalog.property_media candidate
      JOIN platform.media_objects media_object
        ON media_object.id = candidate.platform_media_object_id
       AND media_object.property_id = candidate.property_id
       AND 
  media_object.visibility = 'public'
  AND media_object.public_approved = TRUE
  AND media_object.lifecycle_status = 'active'
  AND media_object.purpose IN (
    'property.hero_image',
    'property.gallery_image',
    'property.logo',
    'pms.room_type.media'
  )

      JOIN platform.media_variants media_variant
        ON media_variant.media_object_id = media_object.id
       AND media_variant.variant_name = 'original_safe'
       AND media_variant.visibility = 'public'
       AND NULLIF(media_variant.public_cdn_url, '') IS NOT NULL
      WHERE candidate.property_id = requested_property_id
        AND candidate.public_approved = TRUE
        AND candidate.source_system = 'platform'
    ) media
    GROUP BY media.property_id
  ),
  amenities AS (
    SELECT
      amenity.property_id,
      jsonb_agg(
        jsonb_build_object('key', amenity.amenity_key, 'label', amenity.label)
        ORDER BY amenity.amenity_key
      ) AS amenities
    FROM hotel_catalog.property_amenities amenity
    WHERE amenity.property_id = requested_property_id
      AND amenity.public_safe = TRUE
    GROUP BY amenity.property_id
  ),
  contacts AS (
    SELECT
      contact.property_id,
      jsonb_agg(
        jsonb_build_object('type', contact.channel_type, 'value', contact.value)
        ORDER BY contact.channel_type, contact.value
      ) AS public_contacts
    FROM hotel_catalog.property_contact_channels contact
    WHERE contact.property_id = requested_property_id
      AND contact.is_public = TRUE
    GROUP BY contact.property_id
  ),
  projection_input AS (
    SELECT
      property.*,
      canonical_slug.id AS canonical_slug_id,
      canonical_slug.slug,
      verified_domain.id AS domain_id,
      verified_domain.hostname AS verified_hostname,
      location.country_code,
      location.region,
      location.city,
      location.latitude,
      location.longitude,
      location.address_public AS locality_public,
      location.geo_public,
      location.map_display_mode,
      descriptions.descriptions,
      approved_media.media AS catalog_media,
      amenities.amenities,
      contacts.public_contacts,
      policy.check_in_time,
      policy.check_in_until,
      policy.check_out_from,
      policy.check_out_time,
      policy.cancellation_summary,
      policy.cancellation_terms_url
    FROM hotel_catalog.properties property
    JOIN canonical_slug ON canonical_slug.property_id = property.id
    LEFT JOIN verified_domain ON verified_domain.property_id = property.id
    LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
    LEFT JOIN descriptions ON descriptions.property_id = property.id
    LEFT JOIN approved_media ON approved_media.property_id = property.id
    LEFT JOIN amenities ON amenities.property_id = property.id
    LEFT JOIN contacts ON contacts.property_id = property.id
    LEFT JOIN hotel_catalog.property_policy_summaries policy ON policy.property_id = property.id
    WHERE property.id = requested_property_id
  )
  INSERT INTO hotel_catalog.property_public_profile_read_model (
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
    source_freshness,
    projected_at
  )
  SELECT
    input.id,
    input.public_id,
    input.display_name,
    input.slug,
    input.domain_id,
    input.verified_hostname,
    input.default_locale,
    input.supported_locales,
    input.profile_status,
    input.completeness_reasons,
    jsonb_strip_nulls(jsonb_build_object(
      'countryCode', CASE
        WHEN COALESCE(input.locality_public, FALSE) THEN input.country_code
      END,
      'region', CASE
        WHEN COALESCE(input.locality_public, FALSE) THEN input.region
      END,
      'city', CASE
        WHEN COALESCE(input.locality_public, FALSE) THEN input.city
      END,
      'geo', CASE
        WHEN COALESCE(input.geo_public, FALSE)
          AND input.map_display_mode IN ('approximate', 'exact')
          AND input.latitude IS NOT NULL
          AND input.longitude IS NOT NULL
          THEN jsonb_build_object(
            'latitude', CASE
              WHEN input.map_display_mode = 'approximate'
                THEN round(input.latitude::numeric, 2)::double precision
              ELSE input.latitude::double precision
            END,
            'longitude', CASE
              WHEN input.map_display_mode = 'approximate'
                THEN round(input.longitude::numeric, 2)::double precision
              ELSE input.longitude::double precision
            END
          )
      END,
      'mapDisplayMode', CASE
        WHEN COALESCE(input.geo_public, FALSE)
          AND input.map_display_mode IN ('approximate', 'exact')
          AND input.latitude IS NOT NULL
          AND input.longitude IS NOT NULL
          THEN input.map_display_mode
      END
    )),
    COALESCE(input.descriptions, '{}'::jsonb),
    COALESCE(input.catalog_media, '[]'::jsonb),
    COALESCE(input.amenities, '[]'::jsonb),
    COALESCE(input.public_contacts, '[]'::jsonb),
    jsonb_strip_nulls(jsonb_build_object(
      'checkInTime', CASE
        WHEN input.check_in_time IS NULL THEN NULL
        ELSE to_char(input.check_in_time, 'HH24:MI')
      END,
      'checkOutTime', CASE
        WHEN input.check_out_time IS NULL THEN NULL
        ELSE to_char(input.check_out_time, 'HH24:MI')
      END,
      'checkInUntil', to_char(input.check_in_until, 'HH24:MI'),
      'checkOutFrom', to_char(input.check_out_from, 'HH24:MI'),
      'cancellationSummary', input.cancellation_summary,
      'termsUrl', input.cancellation_terms_url
    )),
    jsonb_build_object(
      'hotel_catalog', jsonb_build_object('status', 'fresh', 'generatedAt', now())
    ),
    now()
  FROM projection_input input
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
    projected_at = EXCLUDED.projected_at;
  FOR selected_offer_id IN SELECT offer.id FROM marketplace.marketplace_offers offer
    WHERE offer.property_id=requested_property_id AND offer.offer_status<>'archived' ORDER BY offer.id LOOP
INSERT INTO marketplace.marketplace_offer_read_model (
       offer_id,
       property_id,
       public_id,
       canonical_slug,
       display_name,
       offer_title,
       offer_summary,
       accommodation_type,
       visibility_status,
       location,
       image_urls,
       public_compensation_summary,
       public_creator_requirements,
       source_freshness,
       projected_at
     )
     SELECT
       offer.id,
       offer.property_id,
       COALESCE(offer.source_offer_id, offer.id::text),
       COALESCE(public_profile.canonical_slug, active_slug.slug, property.public_id),
       COALESCE(public_profile.display_name, property.display_name),
       offer.title,
       offer.offer_summary,
       offer.accommodation_type,
       CASE
         WHEN 'initialize' = 'disable' THEN 'disabled'
         WHEN offer.offer_status = 'verified'
          AND marketplace_profile.marketplace_profile_status = 'verified'
          AND marketplace_profile.profile_complete = TRUE
          AND COALESCE(public_profile.profile_status, property.profile_status) = 'complete'
          AND COALESCE(cardinality(offer_media.urls), 0) > 0
          AND NULLIF(btrim(COALESCE(public_profile.display_name, property.display_name)), '')
            IS NOT NULL
          AND (
            NULLIF(public_profile.location->>'city', '') IS NOT NULL
            OR NULLIF(public_profile.location->>'countryCode', '') IS NOT NULL
            OR NULLIF(public_profile.location->>'region', '') IS NOT NULL
          )
           THEN 'public'
         ELSE 'private'
       END,
       jsonb_strip_nulls(jsonb_build_object(
         'countryCode', public_profile.location ->> 'countryCode',
         'region', public_profile.location ->> 'region',
         'city', public_profile.location ->> 'city'
       )),
       COALESCE(offer_media.urls, offer.image_urls, '{}'::text[]),
       COALESCE(compensation.items, '[]'::jsonb),
       COALESCE(requirements.item, '{}'::jsonb),
       jsonb_strip_nulls(jsonb_build_object(
         'source', 'marketplace_admin',
         'catalogProjectedAt', public_profile.projected_at
       )),
       now()
     FROM marketplace.marketplace_offers offer
     JOIN hotel_catalog.properties property ON property.id = offer.property_id
     JOIN marketplace.marketplace_hotel_profiles marketplace_profile
       ON marketplace_profile.property_id = offer.property_id
      AND marketplace_profile.organization_id = offer.organization_id
     LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
       ON public_profile.property_id = offer.property_id
     
  LEFT JOIN LATERAL (
    SELECT
      jsonb_agg(
        jsonb_build_object(
          'mediaObjectId', item.id::text,
          'url', item.url,
          'approvalStatus', CASE
            WHEN item.public_approved THEN 'approved'
            ELSE 'pending_domain_approval'
          END,
          'lifecycleStatus', item.lifecycle_status
        ) ORDER BY item.created_at, item.id
      ) AS items,
      array_agg(item.url ORDER BY item.created_at, item.id)
        FILTER (WHERE item.url IS NOT NULL) AS urls
    FROM (
      SELECT
        media_object.id,
        media_object.created_at,
        media_object.public_approved,
        media_object.lifecycle_status,
        COALESCE(
          (
            SELECT variant.public_cdn_url
            FROM platform.media_variants variant
            WHERE variant.media_object_id = media_object.id
              AND variant.public_cdn_url IS NOT NULL
            ORDER BY CASE variant.variant_name
              WHEN 'original_safe' THEN 0
              WHEN 'large' THEN 1
              WHEN 'thumbnail' THEN 2
              ELSE 3
            END,
            variant.created_at,
            variant.id
            LIMIT 1
          ),
          media_object.source_url,
          CASE
            WHEN media_object.storage_key LIKE 'https://%' THEN media_object.storage_key
            ELSE NULL
          END
        ) AS url
      FROM platform.media_objects media_object
      WHERE media_object.owner_organization_id = offer.organization_id
        AND media_object.resource_product = 'marketplace'
        AND media_object.resource_type = 'marketplace_offer'
        AND media_object.resource_id = offer.id::text
        AND media_object.purpose = 'marketplace.offer.media'
        AND media_object.visibility = 'public'
        AND media_object.public_approved = TRUE
        AND media_object.lifecycle_status = 'active'
    ) item
  ) offer_media ON TRUE

     LEFT JOIN LATERAL (
       SELECT slug.slug
       FROM hotel_catalog.property_slugs slug
       WHERE slug.property_id = offer.property_id
         AND slug.status = 'active'
       ORDER BY CASE slug.purpose WHEN 'canonical' THEN 0 WHEN 'marketplace_overlay' THEN 1 ELSE 2 END,
                slug.created_at,
                slug.id
       LIMIT 1
     ) active_slug ON TRUE
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_strip_nulls(jsonb_build_object(
           'type', option.compensation_type,
           'months', option.availability_months,
           'platforms', option.platforms,
           'freeStayMinNights', option.free_stay_min_nights,
           'freeStayMaxNights', option.free_stay_max_nights,
           'paidMaxAmount', option.paid_max_amount,
           'discountPercentage', option.discount_percentage,
           'commissionPercentage', option.commission_percentage,
           'minFollowers', option.min_followers,
           'currency', option.currency,
           'termsSummary', option.terms_summary
         )) ORDER BY option.created_at, option.id
       ) AS items
       FROM marketplace.offer_compensation_options option
       WHERE option.offer_id = offer.id
         AND option.property_id = offer.property_id
         AND option.organization_id = offer.organization_id
     ) compensation ON TRUE
     LEFT JOIN LATERAL (
       SELECT jsonb_build_object(
         'platforms', requirement.platforms,
         'countries', requirement.target_countries,
         'ageGroups', requirement.target_age_groups,
         'creatorTypes', requirement.creator_types
       ) AS item
       FROM marketplace.offer_creator_requirements requirement
       WHERE requirement.offer_id = offer.id
         AND requirement.property_id = offer.property_id
         AND requirement.organization_id = offer.organization_id
     ) requirements ON TRUE
     WHERE offer.id = selected_offer_id
     ON CONFLICT (offer_id) DO UPDATE
     SET property_id = EXCLUDED.property_id,
         public_id = EXCLUDED.public_id,
         canonical_slug = EXCLUDED.canonical_slug,
         display_name = EXCLUDED.display_name,
         offer_title = EXCLUDED.offer_title,
         offer_summary = EXCLUDED.offer_summary,
         accommodation_type = EXCLUDED.accommodation_type,
         visibility_status = EXCLUDED.visibility_status,
         location = EXCLUDED.location,
         image_urls = EXCLUDED.image_urls,
         public_compensation_summary = EXCLUDED.public_compensation_summary,
         public_creator_requirements = EXCLUDED.public_creator_requirements,
         source_freshness = EXCLUDED.source_freshness,
         projected_at = EXCLUDED.projected_at;
  END LOOP;
END $profile_projection$;
REVOKE ALL ON FUNCTION platform.hotel_setup_sync_property_read_models(UUID) FROM PUBLIC;
