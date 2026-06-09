-- Fixture: distribution-bookability / distribution.sql
-- Target: identity, hotel_catalog, booking, PMS, finance, and distribution schemas.
--
-- This parity-only fixture inserts already-migrated target rows. There is no
-- source-to-target transform handler for this case.

INSERT INTO identity.users
  (id, email, name, status)
VALUES
  ('f6891000-0000-0000-0000-000000000001', 'owner.distribution@example.test', 'Distribution Owner', 'active'),
  ('f6891000-0000-0000-0000-000000000002', 'platform.distribution@example.test', 'Distribution Platform Reviewer', 'active');

INSERT INTO identity.organizations
  (id, kind, name, slug, status, workos_org_id, workos_external_id)
VALUES
  ('f6892000-0000-0000-0000-000000000001', 'hotel_group', 'Distribution Alpenrose Group', 'distribution-alpenrose-group', 'active', 'org_distribution_alpenrose', 'distribution-alpenrose-group');

INSERT INTO identity.organization_memberships
  (id, organization_id, user_id, status, role_key, workos_membership_id, workos_role_slugs)
VALUES
  ('f6892100-0000-0000-0000-000000000001', 'f6892000-0000-0000-0000-000000000001', 'f6891000-0000-0000-0000-000000000001', 'active', 'hotel_owner', 'membership_distribution_owner', ARRAY['hotel_owner']);

INSERT INTO identity.organization_resource_links
  (id, organization_id, product, resource_type, resource_id, relationship, status)
VALUES
  ('f6892200-0000-0000-0000-000000000001', 'f6892000-0000-0000-0000-000000000001', 'booking', 'booking_hotel', 'booking_hotel_distribution_alpenrose', 'owner', 'active'),
  ('f6892200-0000-0000-0000-000000000002', 'f6892000-0000-0000-0000-000000000001', 'pms', 'pms_hotel', 'pms_hotel_distribution_alpenrose', 'operator', 'active');

INSERT INTO identity.product_entitlements
  (id, organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id, starts_at, metadata)
VALUES
  ('f6892300-0000-0000-0000-000000000001', 'f6892000-0000-0000-0000-000000000001', 'booking', 'booking-engine', 'active', 'booking', 'booking_hotel', 'booking_hotel_distribution_alpenrose', '2026-06-01T00:00:00Z', '{"fixture": "distribution-bookability"}'),
  ('f6892300-0000-0000-0000-000000000002', 'f6892000-0000-0000-0000-000000000001', 'pms', 'pms-core', 'active', 'pms', 'pms_hotel', 'pms_hotel_distribution_alpenrose', '2026-06-01T00:00:00Z', '{"fixture": "distribution-bookability"}');

INSERT INTO hotel_catalog.properties
  (id, public_id, display_name, property_type, category, default_locale, supported_locales, profile_status, completeness_reasons)
VALUES
  ('f6893000-0000-0000-0000-000000000001', 'prop_distribution_alpenrose', 'Distribution Alpenrose', 'hotel', 'boutique', 'en', ARRAY['en', 'de'], 'complete', '{}');

INSERT INTO hotel_catalog.property_source_links
  (id, property_id, source_system, source_table, source_id, relationship, metadata)
VALUES
  ('f6893100-0000-0000-0000-000000000001', 'f6893000-0000-0000-0000-000000000001', 'booking', 'booking_hotels', 'booking_hotel_distribution_alpenrose', 'canonical_input', '{"fixture": "distribution-bookability"}'),
  ('f6893100-0000-0000-0000-000000000002', 'f6893000-0000-0000-0000-000000000001', 'pms', 'hotels', 'pms_hotel_distribution_alpenrose', 'operational_input', '{"fixture": "distribution-bookability"}');

INSERT INTO hotel_catalog.property_slugs
  (id, property_id, slug, locale, purpose, status)
VALUES
  ('f6893200-0000-0000-0000-000000000001', 'f6893000-0000-0000-0000-000000000001', 'distribution-alpenrose', NULL, 'canonical', 'active');

INSERT INTO hotel_catalog.property_public_profile_read_model
  (
    property_id,
    public_id,
    display_name,
    canonical_slug,
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
VALUES
  (
    'f6893000-0000-0000-0000-000000000001',
    'prop_distribution_alpenrose',
    'Distribution Alpenrose',
    'distribution-alpenrose',
    'en',
    ARRAY['en', 'de'],
    'complete',
    '{}',
    '{"country": "AT", "city": "Innsbruck", "region": "Tyrol", "geo": {"latitude": 47.2692, "longitude": 11.4041}, "timezone": "Europe/Vienna"}',
    '{"summary": "Independent alpine hotel near the old town.", "headline": "Alpine direct booking"}',
    '[{"url": "https://cdn.vayada.example/hotels/distribution-alpenrose/front.jpg", "alt": "Distribution Alpenrose exterior"}]',
    '["wifi", "breakfast", "parking"]',
    '[{"kind": "website", "value": "https://distribution-alpenrose.booking.localhost"}]',
    '{"checkInFrom": "15:00", "checkOutUntil": "11:00", "cancellationSummary": "Free cancellation until 7 days before arrival.", "termsUrl": "https://distribution-alpenrose.booking.localhost/en/terms"}',
    '{"hotel_catalog": {"status": "fresh", "generatedAt": "2026-06-09T08:50:00Z"}}',
    '2026-06-09T09:00:00Z'
  );

INSERT INTO booking.quote_sessions
  (
    id,
    property_id,
    request_hash,
    public_quote_reference,
    requested_check_in,
    requested_check_out,
    adults,
    children,
    requested_room_count,
    currency,
    status,
    selected_offer_snapshot,
    totals,
    unavailable_reasons,
    policy_snapshot,
    source_freshness,
    promo_code,
    referral_code,
    expires_at,
    created_at,
    updated_at
  )
VALUES
  (
    'f6894000-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    'distribution-bookability-2026-09-12-2026-09-14-2-0-1',
    'Q-DIST-689',
    '2026-09-12',
    '2026-09-14',
    2,
    0,
    1,
    'EUR',
    'active',
    '{"publicOfferKey": "dist-suite-flex-2026-09-12", "roomType": "Alpine Suite", "ratePlan": "Direct Flexible", "nights": 2}',
    '{"currency": "EUR", "roomTotal": "680.00", "taxesAndFees": "68.00", "discounts": "40.00", "total": "708.00"}',
    '{}',
    '{"cancellation": "Flexible until 7 days before arrival.", "payment": "Card or pay at property."}',
    '{"booking": {"status": "fresh", "generatedAt": "2026-06-09T08:55:00Z"}}',
    'SUMMER689',
    'AFF-DIST-689',
    '2026-06-09T10:00:00Z',
    '2026-06-09T09:00:00Z',
    '2026-06-09T09:01:00Z'
  );

INSERT INTO booking.checkout_contexts
  (
    id,
    quote_session_id,
    property_id,
    locale,
    currency,
    status,
    guest_input,
    selected_addons,
    payment_context,
    promo_context,
    expires_at,
    created_at,
    updated_at
  )
VALUES
  (
    'f6894100-0000-0000-0000-000000000001',
    'f6894000-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    'en',
    'EUR',
    'active',
    '{"booker": {"firstName": "Alina", "lastName": "Distribution", "email": "alina.distribution@example.test", "phone": "+4312345689"}, "specialRequests": "guestSecretNote689"}',
    '[{"addon": "breakfast", "quantity": 2}]',
    '{"provider": "stripe", "providerAccountId": "acct_distribution_property_689", "paymentIntentId": "pi_distribution_689"}',
    '{"promoCode": "SUMMER689", "privateRuleId": "promo_rule_distribution_689"}',
    '2026-06-09T10:00:00Z',
    '2026-06-09T09:02:00Z',
    '2026-06-09T09:02:00Z'
  );

INSERT INTO pms.room_types
  (id, property_id, source_system, source_room_type_id, name, description, category, occupancy_limits, room_attributes, amenities_snapshot, base_rate_amount, currency, active, sort_order, location_summary)
VALUES
  ('f6895000-0000-0000-0000-000000000001', 'f6893000-0000-0000-0000-000000000001', 'migration', 'pms-room-type-distribution-suite-689', 'Alpine Suite', 'Large suite with balcony.', 'suite', '{"adults": 2, "children": 1}', '{"bedType": "king"}', '["balcony", "breakfast"]', 340.00, 'EUR', TRUE, 1, '{"floorBand": "upper"}');

INSERT INTO pms.rooms
  (id, property_id, room_type_id, source_system, source_room_id, room_number, floor, status, sort_order, room_metadata)
VALUES
  ('f6895100-0000-0000-0000-000000000001', 'f6893000-0000-0000-0000-000000000001', 'f6895000-0000-0000-0000-000000000001', 'migration', 'pms-room-409-689', '409', '4', 'available', 1, '{"fixture": "distribution-bookability", "view": "mountain"}');

INSERT INTO pms.rate_plans
  (id, property_id, room_type_id, code, name, rate_type, meal_plan, payment_policy, deposit_policy, cancellation_policy_snapshot, base_rate_amount, currency, active)
VALUES
  ('f6895200-0000-0000-0000-000000000001', 'f6893000-0000-0000-0000-000000000001', 'f6895000-0000-0000-0000-000000000001', 'DIRECT-FLEX', 'Direct Flexible', 'flexible', 'breakfast', '{"payment": "card_or_property"}', '{"depositPercent": 25}', '{"freeUntilDays": 7}', 340.00, 'EUR', TRUE);

INSERT INTO pms.inventory_days
  (property_id, room_type_id, stay_date, total_count, assigned_count, blocked_count, available_count, status, source_freshness)
VALUES
  ('f6893000-0000-0000-0000-000000000001', 'f6895000-0000-0000-0000-000000000001', '2026-09-12', 2, 0, 0, 2, 'open', '{"pms": {"status": "fresh", "generatedAt": "2026-06-09T08:57:00Z"}}'),
  ('f6893000-0000-0000-0000-000000000001', 'f6895000-0000-0000-0000-000000000001', '2026-09-13', 2, 0, 2, 0, 'closed', '{"pms": {"status": "fresh", "generatedAt": "2026-06-09T08:57:00Z"}}');

INSERT INTO finance.payment_provider_accounts
  (
    id,
    property_id,
    account_scope,
    provider,
    provider_account_id,
    status,
    onboarding_status,
    charges_enabled,
    payouts_enabled,
    default_currency,
    capabilities,
    account_metadata,
    sensitive_config_ref
  )
VALUES
  (
    'f6897000-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    'property',
    'stripe',
    'acct_distribution_property_689',
    'active',
    'completed',
    TRUE,
    TRUE,
    'EUR',
    ARRAY['card_payments', 'transfers'],
    '{"fixture": "distribution-bookability", "providerPaymentIntentId": "pi_distribution_689"}',
    'secret_ref_distribution_689'
  );

INSERT INTO finance.payment_settings
  (
    property_id,
    provider_account_id,
    payments_enabled,
    accepted_methods,
    default_currency,
    deposit_policy,
    refund_policy,
    tax_policy,
    statement_descriptor,
    source_system,
    source_settings_id
  )
VALUES
  (
    'f6893000-0000-0000-0000-000000000001',
    'f6897000-0000-0000-0000-000000000001',
    TRUE,
    ARRAY['card', 'pay_at_property'],
    'EUR',
    '{"depositPercent": 25}',
    '{"refundWindowDays": 7}',
    '{"taxIncluded": true}',
    'DISTALPENROSE',
    'booking',
    'booking_payment_settings_distribution_689'
  );

INSERT INTO distribution.public_hotel_bookability_profiles
  (
    property_id,
    finance_payment_settings_property_id,
    public_id,
    canonical_slug,
    canonical_url,
    booking_base_url,
    custom_domain_url,
    timezone,
    default_locale,
    supported_locales,
    default_currency,
    supported_currencies,
    profile_status,
    public_identity,
    location,
    media,
    amenities,
    policies,
    capabilities,
    supported_quote_parameters,
    public_setup_completeness,
    source_freshness,
    freshness_status,
    data_sources,
    generated_at,
    projected_at,
    expires_at
  )
VALUES
  (
    'f6893000-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    'prop_distribution_alpenrose',
    'distribution-alpenrose',
    'https://distribution-alpenrose.booking.localhost/en',
    'https://distribution-alpenrose.booking.localhost',
    NULL,
    'Europe/Vienna',
    'en',
    ARRAY['en', 'de'],
    'EUR',
    ARRAY['EUR', 'USD'],
    'public',
    '{"propertyId": "prop_distribution_alpenrose", "slug": "distribution-alpenrose", "name": "Distribution Alpenrose", "summary": "Independent alpine hotel near the old town."}',
    '{"country": "AT", "city": "Innsbruck", "region": "Tyrol", "latitude": 47.2692, "longitude": 11.4041}',
    '[{"url": "https://cdn.vayada.example/hotels/distribution-alpenrose/front.jpg", "alt": "Distribution Alpenrose exterior"}]',
    '["wifi", "breakfast", "parking"]',
    '{"checkInFrom": "15:00", "checkOutUntil": "11:00", "cancellationSummary": "Free cancellation until 7 days before arrival.", "termsUrl": "https://distribution-alpenrose.booking.localhost/en/terms"}',
    '{"instantBook": true, "onlinePayment": true, "payAtProperty": true, "promoCodes": true, "referralCodes": true, "bookingDeepLinks": true}',
    '{"minRooms": 1, "maxRooms": 4, "minAdults": 1, "maxAdults": 6, "childrenSupported": true, "supportedCurrencies": ["EUR", "USD"], "supportedLocales": ["en", "de"]}',
    '{"status": "ready", "missing": []}',
    '{"hotel_catalog": {"status": "fresh", "generatedAt": "2026-06-09T08:50:00Z"}, "booking": {"status": "fresh", "generatedAt": "2026-06-09T08:55:00Z"}, "pms": {"status": "fresh", "generatedAt": "2026-06-09T08:57:00Z"}, "finance": {"status": "fresh", "generatedAt": "2026-06-09T08:58:00Z"}}',
    'fresh',
    ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution'],
    '2026-06-09T09:00:00Z',
    '2026-06-09T09:00:00Z',
    '2026-06-09T10:00:00Z'
  );

INSERT INTO distribution.public_room_offer_snapshots
  (
    id,
    property_id,
    room_type_id,
    rate_plan_id,
    stay_date,
    public_offer_key,
    availability_status,
    sellable_publicly,
    available_rooms,
    base_price_amount,
    taxes_and_fees_amount,
    discounts_amount,
    currency,
    occupancy,
    room_summary,
    rate_summary,
    payment_options,
    public_policy,
    unavailable_reasons,
    source_freshness,
    freshness_status,
    data_sources,
    generated_at,
    expires_at
  )
VALUES
  (
    'f6898000-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    'f6895000-0000-0000-0000-000000000001',
    'f6895200-0000-0000-0000-000000000001',
    '2026-09-12',
    'dist-suite-flex-2026-09-12',
    'available',
    TRUE,
    2,
    340.00,
    34.00,
    20.00,
    'EUR',
    '{"adults": 2, "children": 1}',
    '{"name": "Alpine Suite", "category": "suite", "amenities": ["balcony", "breakfast"]}',
    '{"name": "Direct Flexible", "mealPlan": "breakfast", "cancellationSummary": "Free cancellation until 7 days before arrival."}',
    ARRAY['card', 'pay_at_property'],
    '{"depositSummary": "25% deposit due at checkout.", "taxIncluded": true}',
    '{}',
    '{"pms": {"status": "fresh", "generatedAt": "2026-06-09T08:57:00Z"}, "finance": {"status": "fresh", "generatedAt": "2026-06-09T08:58:00Z"}}',
    'fresh',
    ARRAY['booking', 'pms', 'finance', 'distribution'],
    '2026-06-09T09:00:00Z',
    '2026-06-09T10:00:00Z'
  ),
  (
    'f6898000-0000-0000-0000-000000000002',
    'f6893000-0000-0000-0000-000000000001',
    'f6895000-0000-0000-0000-000000000001',
    'f6895200-0000-0000-0000-000000000001',
    '2026-09-13',
    'dist-suite-flex-2026-09-13',
    'sold_out',
    FALSE,
    0,
    340.00,
    34.00,
    0.00,
    'EUR',
    '{"adults": 2, "children": 1}',
    '{"name": "Alpine Suite", "category": "suite", "amenities": ["balcony", "breakfast"]}',
    '{"name": "Direct Flexible", "mealPlan": "breakfast", "cancellationSummary": "Free cancellation until 7 days before arrival."}',
    ARRAY['card', 'pay_at_property'],
    '{"depositSummary": "25% deposit due at checkout.", "taxIncluded": true}',
    ARRAY['sold_out'],
    '{"pms": {"status": "fresh", "generatedAt": "2026-06-09T08:57:00Z"}, "finance": {"status": "fresh", "generatedAt": "2026-06-09T08:58:00Z"}}',
    'fresh',
    ARRAY['booking', 'pms', 'finance', 'distribution'],
    '2026-06-09T09:00:00Z',
    '2026-06-09T10:00:00Z'
  );

INSERT INTO distribution.public_quote_read_models
  (
    quote_session_id,
    property_id,
    public_quote_reference,
    quote_hash,
    request_snapshot,
    quote_status,
    unavailable_reasons,
    offers,
    totals,
    deep_link_url,
    price_guarantee,
    currency,
    source_freshness,
    freshness_status,
    data_sources,
    generated_at,
    expires_at,
    projected_at
  )
VALUES
  (
    'f6894000-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    'Q-DIST-689',
    'quote_hash_distribution_689',
    '{"hotelSlug": "distribution-alpenrose", "checkIn": "2026-09-12", "checkOut": "2026-09-14", "nights": 2, "adults": 2, "children": 0, "rooms": 1, "currency": "EUR", "locale": "en", "promoCode": "SUMMER689", "referralCode": "AFF-DIST-689"}',
    'bookable',
    '[]',
    '[{"publicOfferKey": "dist-suite-flex-2026-09-12", "roomTypeName": "Alpine Suite", "ratePlanName": "Direct Flexible", "nights": 2, "availableRooms": 2, "amount": "680.00", "currency": "EUR"}]',
    '{"currency": "EUR", "roomTotal": "680.00", "taxesAndFees": "68.00", "discounts": "40.00", "total": "708.00", "depositDue": "177.00"}',
    'https://distribution-alpenrose.booking.localhost/en/checkout?quote=Q-DIST-689&ctx=public-dist-689',
    'expires_at',
    'EUR',
    '{"booking": {"status": "fresh", "generatedAt": "2026-06-09T08:55:00Z"}, "pms": {"status": "fresh", "generatedAt": "2026-06-09T08:57:00Z"}, "finance": {"status": "fresh", "generatedAt": "2026-06-09T08:58:00Z"}}',
    'fresh',
    ARRAY['booking', 'pms', 'finance', 'distribution'],
    '2026-06-09T09:00:00Z',
    '2026-06-09T10:00:00Z',
    '2026-06-09T09:00:00Z'
  );

INSERT INTO distribution.booking_deep_link_contexts
  (
    id,
    property_id,
    quote_session_id,
    checkout_context_id,
    public_quote_reference,
    context_token_hash,
    deep_link_url,
    status,
    locale,
    currency,
    check_in,
    check_out,
    adults,
    children,
    rooms,
    promo_code,
    referral_code,
    preserves,
    request_context,
    source_freshness,
    expires_at,
    created_at,
    updated_at
  )
VALUES
  (
    'f6898100-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    'f6894000-0000-0000-0000-000000000001',
    'f6894100-0000-0000-0000-000000000001',
    'Q-DIST-689',
    'sha256:deep-link-token-689',
    'https://distribution-alpenrose.booking.localhost/en/checkout?quote=Q-DIST-689&ctx=public-dist-689',
    'active',
    'en',
    'EUR',
    '2026-09-12',
    '2026-09-14',
    2,
    0,
    1,
    'SUMMER689',
    'AFF-DIST-689',
    ARRAY['dates', 'guests', 'rooms', 'currency', 'locale', 'promo_code', 'referral_code', 'quote_id'],
    '{"hotelSlug": "distribution-alpenrose", "checkIn": "2026-09-12", "checkOut": "2026-09-14", "adults": 2, "children": 0, "rooms": 1, "currency": "EUR", "locale": "en", "promoCode": "SUMMER689", "referralCode": "AFF-DIST-689"}',
    '{"distribution": {"status": "fresh", "generatedAt": "2026-06-09T09:00:00Z"}}',
    '2026-06-09T10:00:00Z',
    '2026-06-09T09:00:00Z',
    '2026-06-09T09:00:00Z'
  );

INSERT INTO distribution.external_api_clients
  (
    id,
    public_client_id,
    client_name,
    contact_email,
    status,
    allowed_surfaces,
    rate_limit_tier,
    terms_version,
    credential_hash_ref,
    credential_rotated_at,
    created_by_user_id,
    revoked_by_user_id,
    revoked_at,
    revocation_reason,
    last_seen_at,
    client_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'f6898200-0000-0000-0000-000000000001',
    'client_dist_partner_689',
    'Distribution Partner Agent',
    'agent-integrations@example.test',
    'active',
    ARRAY['public_profile', 'public_quote', 'deep_link'],
    'partner',
    'public-ai-terms-2026-06',
    'cred_hash_dist_partner_689',
    '2026-06-09T08:00:00Z',
    'f6891000-0000-0000-0000-000000000001',
    NULL,
    NULL,
    NULL,
    '2026-06-09T09:06:00Z',
    '{"integration": "public-agent", "fixture": "distribution-bookability"}',
    '2026-06-09T08:00:00Z',
    '2026-06-09T09:06:00Z'
  ),
  (
    'f6898200-0000-0000-0000-000000000002',
    'client_dist_revoked_689',
    'Revoked Distribution Client',
    'revoked-integrations@example.test',
    'revoked',
    ARRAY['public_profile'],
    'blocked',
    'public-ai-terms-2026-06',
    'cred_hash_dist_revoked_689',
    '2026-06-08T08:00:00Z',
    'f6891000-0000-0000-0000-000000000001',
    'f6891000-0000-0000-0000-000000000002',
    '2026-06-09T08:30:00Z',
    'Fixture revoked client validates revocation state.',
    NULL,
    '{"integration": "public-agent", "fixture": "distribution-bookability", "revoked": true}',
    '2026-06-08T08:00:00Z',
    '2026-06-09T08:30:00Z'
  );

INSERT INTO distribution.external_api_usage_events
  (
    id,
    client_id,
    property_id,
    quote_session_id,
    deep_link_context_id,
    occurred_at,
    surface,
    request_method,
    route_template,
    response_status,
    rate_limit_policy,
    rate_limit_tier,
    rate_limit_key_hash,
    request_fingerprint_hash,
    ip_address_hash,
    user_agent_hash,
    cache_status,
    latency_ms,
    client_visible_error_code,
    abuse_flags,
    usage_metadata
  )
VALUES
  (
    'f6898300-0000-0000-0000-000000000001',
    'f6898200-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    NULL,
    NULL,
    '2026-06-09T09:04:00Z',
    'public_profile',
    'GET',
    '/api/ai/hotels/{slug}',
    200,
    'public-ai-profile-read',
    'partner',
    'rl_hash_dist_partner_689',
    'fp_hash_profile_689',
    'ip_hash_689',
    'ua_hash_689',
    'hit',
    32,
    NULL,
    '{}',
    '{"contractVersion": "public-bookability.v1", "publicVisibility": "public_safe", "result": "profile"}'
  ),
  (
    'f6898300-0000-0000-0000-000000000002',
    'f6898200-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    'f6894000-0000-0000-0000-000000000001',
    NULL,
    '2026-06-09T09:05:00Z',
    'public_quote',
    'GET',
    '/api/ai/hotels/{slug}/quote',
    200,
    'public-ai-quote-read',
    'partner',
    'rl_hash_dist_partner_689',
    'fp_hash_quote_689',
    'ip_hash_689',
    'ua_hash_689',
    'miss',
    81,
    NULL,
    '{}',
    '{"contractVersion": "public-bookability.v1", "publicVisibility": "public_safe", "result": "quote", "quoteReference": "Q-DIST-689"}'
  ),
  (
    'f6898300-0000-0000-0000-000000000003',
    'f6898200-0000-0000-0000-000000000001',
    'f6893000-0000-0000-0000-000000000001',
    'f6894000-0000-0000-0000-000000000001',
    'f6898100-0000-0000-0000-000000000001',
    '2026-06-09T09:06:00Z',
    'deep_link',
    'GET',
    '/api/ai/hotels/{slug}/quote/deep-link',
    302,
    'public-ai-deep-link',
    'partner',
    'rl_hash_dist_partner_689',
    'fp_hash_deep_link_689',
    'ip_hash_689',
    'ua_hash_689',
    'bypass',
    45,
    NULL,
    '{}',
    '{"contractVersion": "public-bookability.v1", "publicVisibility": "public_safe", "result": "deep_link", "quoteReference": "Q-DIST-689"}'
  );
