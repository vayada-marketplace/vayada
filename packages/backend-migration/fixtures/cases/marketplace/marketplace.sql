-- Fixture: marketplace / marketplace.sql
-- Target: identity, hotel_catalog, finance, and marketplace schemas.
--
-- This parity-only fixture inserts already-migrated target rows. There is no
-- source-to-target transform handler for this case.

INSERT INTO identity.users
  (id, email, name, status)
VALUES
  ('f6881000-0000-0000-0000-000000000001', 'hotel.marketplace@example.test', 'Marketplace Hotel Owner', 'active'),
  ('f6881000-0000-0000-0000-000000000002', 'creator.marketplace@example.test', 'Marketplace Creator Owner', 'active'),
  ('f6881000-0000-0000-0000-000000000003', 'platform.marketplace@example.test', 'Marketplace Platform Admin', 'active');

INSERT INTO identity.organizations
  (id, kind, name, slug, status, workos_org_id, workos_external_id)
VALUES
  ('f6882000-0000-0000-0000-000000000001', 'hotel_group', 'Marketplace Alpenrose Group', 'marketplace-alpenrose-group', 'active', 'org_marketplace_alpenrose', 'marketplace-alpenrose-group'),
  ('f6882000-0000-0000-0000-000000000002', 'creator_workspace', 'Mara Lens Studio', 'mara-lens-studio', 'active', 'org_marketplace_mara_lens', 'mara-lens-studio');

INSERT INTO identity.organization_memberships
  (id, organization_id, user_id, status, role_key, workos_membership_id, workos_role_slugs)
VALUES
  ('f6882100-0000-0000-0000-000000000001', 'f6882000-0000-0000-0000-000000000001', 'f6881000-0000-0000-0000-000000000001', 'active', 'hotel_owner', 'membership_marketplace_hotel_owner', ARRAY['hotel_owner']),
  ('f6882100-0000-0000-0000-000000000002', 'f6882000-0000-0000-0000-000000000002', 'f6881000-0000-0000-0000-000000000002', 'active', 'creator_owner', 'membership_marketplace_creator_owner', ARRAY['creator_owner']);

INSERT INTO identity.organization_resource_links
  (id, organization_id, product, resource_type, resource_id, relationship, status)
VALUES
  ('f6882200-0000-0000-0000-000000000001', 'f6882000-0000-0000-0000-000000000001', 'marketplace', 'hotel_profile', 'f6883000-0000-0000-0000-000000000001', 'owner', 'active'),
  ('f6882200-0000-0000-0000-000000000002', 'f6882000-0000-0000-0000-000000000001', 'marketplace', 'hotel_listing', 'f6885000-0000-0000-0000-000000000001', 'owner', 'active'),
  ('f6882200-0000-0000-0000-000000000003', 'f6882000-0000-0000-0000-000000000002', 'marketplace', 'creator_profile', 'f6884000-0000-0000-0000-000000000001', 'owner', 'active');

INSERT INTO identity.product_entitlements
  (id, organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id, starts_at, metadata)
VALUES
  ('f6882300-0000-0000-0000-000000000001', 'f6882000-0000-0000-0000-000000000001', 'marketplace', 'marketplace-hotel-profile', 'active', 'marketplace', 'hotel_profile', 'f6883000-0000-0000-0000-000000000001', '2026-06-01T00:00:00Z', '{"fixture": "marketplace"}'),
  ('f6882300-0000-0000-0000-000000000002', 'f6882000-0000-0000-0000-000000000001', 'marketplace', 'marketplace-hotel-listing', 'active', 'marketplace', 'hotel_listing', 'f6885000-0000-0000-0000-000000000001', '2026-06-01T00:00:00Z', '{"fixture": "marketplace"}'),
  ('f6882300-0000-0000-0000-000000000003', 'f6882000-0000-0000-0000-000000000002', 'marketplace', 'marketplace-creator-profile', 'active', 'marketplace', 'creator_profile', 'f6884000-0000-0000-0000-000000000001', '2026-06-01T00:00:00Z', '{"fixture": "marketplace"}');

INSERT INTO hotel_catalog.properties
  (id, public_id, display_name, property_type, category, default_locale, supported_locales, profile_status, completeness_reasons)
VALUES
  ('f6883000-0000-0000-0000-000000000001', 'prop_marketplace_alpenrose', 'Marketplace Alpenrose', 'hotel', 'boutique', 'en', ARRAY['en', 'de'], 'complete', '{}');

INSERT INTO hotel_catalog.property_source_links
  (id, property_id, source_system, source_table, source_id, relationship, metadata)
VALUES
  ('f6883100-0000-0000-0000-000000000001', 'f6883000-0000-0000-0000-000000000001', 'marketplace', 'hotel_profiles', 'marketplace-hotel-profile-688', 'profile_input', '{"fixture": "marketplace"}'),
  ('f6883100-0000-0000-0000-000000000002', 'f6883000-0000-0000-0000-000000000001', 'marketplace', 'hotel_listings', 'marketplace-listing-688', 'listing_input', '{"fixture": "marketplace"}');

INSERT INTO hotel_catalog.property_slugs
  (id, property_id, slug, locale, purpose, status)
VALUES
  ('f6883200-0000-0000-0000-000000000001', 'f6883000-0000-0000-0000-000000000001', 'marketplace-alpenrose', NULL, 'marketplace_overlay', 'active');

INSERT INTO finance.commission_rules
  (
    id,
    property_id,
    organization_id,
    rule_scope,
    product,
    commission_type,
    percentage_rate,
    currency,
    status,
    starts_at,
    source_system,
    source_rule_id,
    rule_metadata
  )
VALUES
  (
    'f6887000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    'marketplace',
    'marketplace',
    'percentage',
    10.0000,
    'EUR',
    'active',
    '2026-06-01T00:00:00Z',
    'marketplace',
    'marketplace-commission-rule-688',
    '{"fixture": "marketplace"}'
  );

INSERT INTO marketplace.creator_profiles
  (
    id,
    organization_id,
    owner_user_id,
    source_system,
    source_creator_id,
    display_name,
    creator_type,
    location_text,
    short_description,
    portfolio_url,
    phone,
    profile_picture_url,
    profile_complete,
    profile_completed_at,
    profile_status,
    profile_metadata,
    pii_retention_until,
    created_at,
    updated_at
  )
VALUES
  (
    'f6884000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000002',
    'f6881000-0000-0000-0000-000000000002',
    'migration',
    'marketplace-creator-688',
    'Mara Lens',
    'travel',
    'Innsbruck, Austria',
    'Travel creator focused on alpine boutique hotels.',
    'https://mara.example.test',
    '+43123456888',
    'https://cdn.example.test/creators/mara.jpg',
    TRUE,
    '2026-06-01T10:00:00Z',
    'active',
    '{"fixture": "marketplace", "internalSegment": "creatorSecretRate"}',
    '2027-06-01',
    '2026-06-01T09:00:00Z',
    '2026-06-01T10:00:00Z'
  );

INSERT INTO marketplace.creator_platforms
  (
    id,
    creator_profile_id,
    organization_id,
    source_system,
    source_platform_id,
    platform,
    handle,
    profile_url,
    follower_count,
    engagement_rate,
    audience_countries,
    audience_age_groups,
    audience_gender_split,
    verification_status,
    platform_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6884100-0000-0000-0000-000000000001',
    'f6884000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000002',
    'migration',
    'marketplace-platform-688',
    'instagram',
    '@maralens',
    'https://instagram.example.test/maralens',
    82400,
    4.2500,
    '["AT", "DE", "CH"]',
    '["25-34", "35-44"]',
    '{"female": 55, "male": 43, "unknown": 2}',
    'verified',
    '{"fixture": "marketplace", "audienceSnapshot": "platform-internal-approval-688"}',
    '2026-06-01T09:15:00Z',
    '2026-06-01T09:45:00Z'
  );

INSERT INTO marketplace.marketplace_hotel_profiles
  (
    property_id,
    organization_id,
    source_system,
    source_hotel_profile_id,
    marketplace_profile_status,
    profile_complete,
    profile_completed_at,
    host_summary,
    collaboration_guidelines,
    marketplace_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6883000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    'migration',
    'marketplace-hotel-profile-688',
    'verified',
    TRUE,
    '2026-06-01T11:00:00Z',
    'Family-run alpine boutique hotel with creator-friendly experiences.',
    'Creators receive a private briefing before arrival.',
    '{"fixture": "marketplace", "privateOnboardingNote": "host-private-briefing-688"}',
    '2026-06-01T09:30:00Z',
    '2026-06-01T11:00:00Z'
  );

INSERT INTO marketplace.marketplace_hotel_listings
  (
    id,
    property_id,
    organization_id,
    source_system,
    source_listing_id,
    title,
    listing_summary,
    accommodation_type,
    listing_status,
    raw_location_text,
    image_urls,
    listing_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6885000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    'migration',
    'marketplace-listing-688',
    'Alpine creator stay at Marketplace Alpenrose',
    'Two-night creator collaboration stay near Innsbruck.',
    'boutique_hotel',
    'verified',
    'Innsbruck, Austria',
    ARRAY['https://cdn.example.test/marketplace/alpenrose-hero.jpg', 'https://cdn.example.test/marketplace/alpenrose-room.jpg'],
    '{"fixture": "marketplace", "privateYieldTag": "yield-private-688"}',
    '2026-06-01T09:35:00Z',
    '2026-06-01T11:05:00Z'
  );

INSERT INTO marketplace.listing_collaboration_offerings
  (
    id,
    listing_id,
    property_id,
    organization_id,
    source_system,
    source_offering_id,
    collaboration_type,
    availability_months,
    platforms,
    free_stay_min_nights,
    free_stay_max_nights,
    commission_percentage,
    min_followers,
    currency,
    terms_summary,
    offering_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6885100-0000-0000-0000-000000000001',
    'f6885000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    'migration',
    'marketplace-offering-free-stay-688',
    'free_stay',
    ARRAY['June', 'September'],
    ARRAY['instagram', 'tiktok'],
    2,
    4,
    NULL,
    50000,
    'EUR',
    'Hosted stay for public content deliverables.',
    '{"fixture": "marketplace"}',
    '2026-06-01T09:40:00Z',
    '2026-06-01T09:50:00Z'
  ),
  (
    'f6885100-0000-0000-0000-000000000002',
    'f6885000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    'migration',
    'marketplace-offering-affiliate-688',
    'affiliate',
    ARRAY['June', 'July', 'August'],
    ARRAY['instagram'],
    NULL,
    NULL,
    10.0000,
    50000,
    'EUR',
    'Affiliate collaboration with private tracking handled off the public listing.',
    '{"fixture": "marketplace", "commissionRuleId": "f6887000-0000-0000-0000-000000000001"}',
    '2026-06-01T09:42:00Z',
    '2026-06-01T09:52:00Z'
  );

INSERT INTO marketplace.listing_creator_requirements
  (
    id,
    listing_id,
    property_id,
    organization_id,
    source_system,
    source_requirement_id,
    platforms,
    target_countries,
    target_age_min,
    target_age_max,
    target_age_groups,
    creator_types,
    requirement_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6885200-0000-0000-0000-000000000001',
    'f6885000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    'migration',
    'marketplace-requirement-688',
    ARRAY['instagram', 'tiktok'],
    ARRAY['AT', 'DE', 'CH'],
    25,
    44,
    ARRAY['25-34', '35-44'],
    ARRAY['travel', 'lifestyle'],
    '{"fixture": "marketplace"}',
    '2026-06-01T09:45:00Z',
    '2026-06-01T09:55:00Z'
  );

INSERT INTO marketplace.collaborations
  (
    id,
    creator_profile_id,
    creator_organization_id,
    property_id,
    hotel_organization_id,
    listing_id,
    commission_rule_id,
    source_system,
    source_collaboration_id,
    initiator_type,
    lifecycle_status,
    collaboration_type,
    application_message,
    negotiated_terms,
    platform_deliverables,
    preferred_months,
    travel_date_from,
    travel_date_to,
    free_stay_min_nights,
    free_stay_max_nights,
    creator_fee,
    currency,
    affiliate_referral_code,
    affiliate_link,
    creator_consent,
    hotel_agreed_at,
    creator_agreed_at,
    term_last_updated_at,
    responded_at,
    collaboration_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6886000-0000-0000-0000-000000000001',
    'f6884000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000002',
    'f6883000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    'f6885000-0000-0000-0000-000000000001',
    'f6887000-0000-0000-0000-000000000001',
    'migration',
    'marketplace-collaboration-688',
    'creator',
    'accepted',
    'affiliate',
    'PRIVATE_CREATOR_APPLICATION_688',
    '{"creatorFee": "10.0000", "privateComp": "creatorSecretRate", "briefing": "private-negotiated-terms-688"}',
    '[{"platform": "instagram", "type": "reel", "quantity": 1}, {"platform": "tiktok", "type": "story", "quantity": 2}]',
    ARRAY['June'],
    '2026-06-20',
    '2026-06-23',
    2,
    3,
    10.0000,
    'EUR',
    'AFF-PRIVATE-688',
    'https://private.example.test/aff-688',
    TRUE,
    '2026-06-02T10:00:00Z',
    '2026-06-02T09:30:00Z',
    '2026-06-02T10:00:00Z',
    '2026-06-02T10:05:00Z',
    '{"fixture": "marketplace"}',
    '2026-06-01T12:00:00Z',
    '2026-06-02T10:05:00Z'
  );

INSERT INTO marketplace.creator_ratings
  (
    id,
    creator_profile_id,
    creator_organization_id,
    property_id,
    hotel_organization_id,
    collaboration_id,
    rating,
    comment,
    created_by_user_id,
    created_at,
    updated_at
  )
VALUES
  (
    'f6886200-0000-0000-0000-000000000001',
    'f6884000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000002',
    'f6883000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    'f6886000-0000-0000-0000-000000000001',
    5,
    'Excellent collaboration; internal rating note stays private.',
    'f6881000-0000-0000-0000-000000000001',
    '2026-06-25T10:00:00Z',
    '2026-06-25T10:00:00Z'
  );

INSERT INTO marketplace.collaboration_deliverables
  (
    id,
    collaboration_id,
    property_id,
    platform,
    deliverable_type,
    quantity,
    deliverable_status,
    due_at,
    submitted_at,
    completed_at,
    content_url,
    review_notes,
    deliverable_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6886100-0000-0000-0000-000000000001',
    'f6886000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'instagram',
    'reel',
    1,
    'approved',
    '2026-06-24T12:00:00Z',
    '2026-06-23T18:00:00Z',
    '2026-06-24T09:00:00Z',
    'https://content.example.test/reel-688',
    'Approved for publication.',
    '{"fixture": "marketplace"}',
    '2026-06-02T10:10:00Z',
    '2026-06-24T09:00:00Z'
  ),
  (
    'f6886100-0000-0000-0000-000000000002',
    'f6886000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'tiktok',
    'story',
    2,
    'submitted',
    '2026-06-24T12:00:00Z',
    '2026-06-23T19:00:00Z',
    NULL,
    'https://content.example.test/story-688',
    'Awaiting final hotel approval.',
    '{"fixture": "marketplace"}',
    '2026-06-02T10:11:00Z',
    '2026-06-23T19:00:00Z'
  );

INSERT INTO marketplace.marketplace_chat_messages
  (
    id,
    collaboration_id,
    property_id,
    sender_user_id,
    sender_type,
    message_type,
    body,
    message_metadata,
    read_at,
    pii_retention_until,
    created_at
  )
VALUES
  (
    'f6886300-0000-0000-0000-000000000001',
    'f6886000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'f6881000-0000-0000-0000-000000000002',
    'creator',
    'text',
    'PRIVATE_CREATOR_CHAT_688',
    '{"fixture": "marketplace", "thread": "creator-private-thread-688"}',
    '2026-06-02T10:20:00Z',
    '2027-06-23',
    '2026-06-02T10:15:00Z'
  ),
  (
    'f6886300-0000-0000-0000-000000000002',
    'f6886000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'f6881000-0000-0000-0000-000000000001',
    'hotel',
    'text',
    'PRIVATE_HOTEL_CHAT_688',
    '{"fixture": "marketplace", "thread": "hotel-private-thread-688"}',
    NULL,
    '2027-06-23',
    '2026-06-02T10:16:00Z'
  );

INSERT INTO marketplace.trips
  (
    id,
    creator_profile_id,
    organization_id,
    source_system,
    source_trip_id,
    name,
    location_text,
    start_date,
    end_date,
    notes,
    trip_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6886400-0000-0000-0000-000000000001',
    'f6884000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000002',
    'migration',
    'marketplace-trip-688',
    'June Alpine Content Trip',
    'Tyrol, Austria',
    '2026-06-20',
    '2026-06-27',
    'Creator-private itinerary details.',
    '{"fixture": "marketplace"}',
    '2026-06-01T08:00:00Z',
    '2026-06-01T08:30:00Z'
  );

INSERT INTO marketplace.external_collaborations
  (
    id,
    creator_profile_id,
    organization_id,
    trip_id,
    source_system,
    source_external_collaboration_id,
    title,
    hotel_name,
    location_text,
    collaboration_type,
    start_date,
    end_date,
    deliverables_summary,
    notes,
    external_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6886500-0000-0000-0000-000000000001',
    'f6884000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000002',
    'f6886400-0000-0000-0000-000000000001',
    'migration',
    'marketplace-external-collaboration-688',
    'External Vienna Campaign',
    'External Hotel Wien',
    'Vienna, Austria',
    'paid',
    '2026-06-25',
    '2026-06-26',
    'One paid Instagram carousel.',
    'External private contract reference EXT-PRIVATE-688.',
    '{"fixture": "marketplace"}',
    '2026-06-01T08:45:00Z',
    '2026-06-01T08:55:00Z'
  );

INSERT INTO marketplace.marketplace_notifications
  (
    id,
    recipient_user_id,
    organization_id,
    notification_type,
    title,
    body,
    link_url,
    resource_type,
    resource_id,
    notification_metadata,
    read_at,
    created_at
  )
VALUES
  (
    'f6886600-0000-0000-0000-000000000001',
    'f6881000-0000-0000-0000-000000000002',
    'f6882000-0000-0000-0000-000000000002',
    'collaboration.accepted',
    'Collaboration accepted',
    'The hotel accepted your private collaboration terms.',
    '/marketplace/collaborations/f6886000-0000-0000-0000-000000000001',
    'collaboration',
    'f6886000-0000-0000-0000-000000000001',
    '{"fixture": "marketplace"}',
    NULL,
    '2026-06-02T10:06:00Z'
  ),
  (
    'f6886600-0000-0000-0000-000000000002',
    'f6881000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    'creator.approved',
    'Creator profile approved',
    'Mara Lens is approved for the Marketplace Alpenrose listing.',
    '/marketplace/creators/f6884000-0000-0000-0000-000000000001',
    'creator_profile',
    'f6884000-0000-0000-0000-000000000001',
    '{"fixture": "marketplace"}',
    '2026-06-02T11:00:00Z',
    '2026-06-02T10:30:00Z'
  );

INSERT INTO marketplace.invite_codes
  (
    id,
    code,
    invite_type,
    status,
    payload,
    created_by_user_id,
    redeemed_by_user_id,
    creator_profile_id,
    creator_organization_id,
    property_id,
    redeemed_at,
    expires_at,
    created_at
  )
VALUES
  (
    'f6886700-0000-0000-0000-000000000001',
    'MARKET-688-CREATOR',
    'creator',
    'pending',
    '{"fixture": "marketplace", "audience": "travel"}',
    'f6881000-0000-0000-0000-000000000003',
    NULL,
    'f6884000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000002',
    'f6883000-0000-0000-0000-000000000001',
    NULL,
    '2026-07-01T00:00:00Z',
    '2026-06-01T08:00:00Z'
  ),
  (
    'f6886700-0000-0000-0000-000000000002',
    'MARKET-688-REDEEMED',
    'creator',
    'redeemed',
    '{"fixture": "marketplace", "campaign": "summer"}',
    'f6881000-0000-0000-0000-000000000003',
    'f6881000-0000-0000-0000-000000000002',
    'f6884000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000002',
    'f6883000-0000-0000-0000-000000000001',
    '2026-06-03T09:00:00Z',
    '2026-07-01T00:00:00Z',
    '2026-06-01T08:05:00Z'
  );

INSERT INTO marketplace.newsletter_preferences
  (
    id,
    user_id,
    organization_id,
    enabled,
    country_filter,
    source_system,
    source_preference_id,
    created_at,
    updated_at
  )
VALUES
  (
    'f6886800-0000-0000-0000-000000000001',
    'f6881000-0000-0000-0000-000000000002',
    'f6882000-0000-0000-0000-000000000002',
    TRUE,
    ARRAY['AT', 'DE'],
    'migration',
    'marketplace-newsletter-creator-688',
    '2026-06-01T07:00:00Z',
    '2026-06-01T07:00:00Z'
  ),
  (
    'f6886800-0000-0000-0000-000000000002',
    'f6881000-0000-0000-0000-000000000001',
    'f6882000-0000-0000-0000-000000000001',
    FALSE,
    NULL,
    'migration',
    'marketplace-newsletter-hotel-688',
    '2026-06-01T07:05:00Z',
    '2026-06-01T07:05:00Z'
  );

INSERT INTO marketplace.marketplace_listing_read_model
  (
    listing_id,
    property_id,
    public_id,
    canonical_slug,
    display_name,
    listing_title,
    listing_summary,
    accommodation_type,
    visibility_status,
    location,
    image_urls,
    public_offering_summary,
    public_creator_requirements,
    source_freshness,
    projected_at
  )
VALUES
  (
    'f6885000-0000-0000-0000-000000000001',
    'f6883000-0000-0000-0000-000000000001',
    'marketplace-listing-688',
    'marketplace-alpenrose',
    'Marketplace Alpenrose',
    'Alpine creator stay at Marketplace Alpenrose',
    'Two-night creator collaboration stay near Innsbruck.',
    'boutique_hotel',
    'public',
    '{"countryCode": "AT", "region": "Tyrol", "city": "Innsbruck", "display": "Innsbruck, Austria", "mapDisplayMode": "approximate"}',
    ARRAY['https://cdn.example.test/marketplace/alpenrose-hero.jpg', 'https://cdn.example.test/marketplace/alpenrose-room.jpg'],
    '[{"type": "free_stay", "months": ["June", "September"], "nights": {"min": 2, "max": 4}, "platforms": ["instagram", "tiktok"]}, {"type": "affiliate", "commissionPercent": 10, "platforms": ["instagram"]}]',
    '{"platforms": ["instagram", "tiktok"], "countries": ["AT", "DE", "CH"], "ageGroups": ["25-34", "35-44"], "creatorTypes": ["travel", "lifestyle"], "minFollowers": 50000}',
    '{"marketplace": {"status": "fresh", "projectedAt": "2026-06-02T12:00:00Z"}}',
    '2026-06-02T12:00:00Z'
  );
