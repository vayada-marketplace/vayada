-- Fixture: property-catalog-public-profiles / catalog.sql
-- Target: hotel_catalog schema tables.
--
-- Covers:
-- 1. complete property: Booking + PMS + Marketplace inputs reconcile cleanly.
-- 2. missing-location property: Marketplace free-form location is preserved but
--    not promoted to canonical structured fields.
-- 3. custom-domain property: verified custom domain is available for canonical
--    URL policy consumers without becoming a second property identity.

INSERT INTO hotel_catalog.properties
  (id, public_id, display_name, property_type, category, default_locale, supported_locales, profile_status, completeness_reasons)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'prop_hotel_alpenrose', 'Hotel Alpenrose', 'hotel', 'boutique', 'en', ARRAY['en', 'de'], 'complete', '{}'),
  ('c1000000-0000-0000-0000-000000000002', 'prop_hidden_bay', 'Hidden Bay Villas', 'villa', 'resort', 'en', ARRAY['en'], 'incomplete', ARRAY['location_unverified', 'timezone_missing']),
  ('c1000000-0000-0000-0000-000000000003', 'prop_casa_daliya', 'Casa Daliya', 'villa', 'boutique', 'en', ARRAY['en', 'es'], 'complete', '{}');

INSERT INTO hotel_catalog.property_source_links
  (property_id, source_system, source_table, source_id, relationship, metadata)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'booking', 'booking_hotels', 'booking_hotel_alpenrose', 'canonical_input', '{"display_name_priority": 1}'),
  ('c1000000-0000-0000-0000-000000000001', 'pms', 'hotels', 'pms_hotel_alpenrose', 'operational_input', '{"timezone_source": "pms"}'),
  ('c1000000-0000-0000-0000-000000000001', 'marketplace', 'hotel_profiles', 'marketplace_profile_alpenrose', 'profile_input', '{"copy_source": true}'),
  ('c1000000-0000-0000-0000-000000000002', 'booking', 'booking_hotels', 'booking_hotel_hidden_bay', 'canonical_input', '{}'),
  ('c1000000-0000-0000-0000-000000000002', 'marketplace', 'hotel_profiles', 'marketplace_profile_hidden_bay', 'profile_input', '{"free_form_location_only": true}'),
  ('c1000000-0000-0000-0000-000000000003', 'booking', 'booking_hotels', 'booking_hotel_casa_daliya', 'canonical_input', '{"custom_domain_source": true}'),
  ('c1000000-0000-0000-0000-000000000003', 'pms', 'hotels', 'pms_hotel_casa_daliya', 'operational_input', '{}'),
  ('c1000000-0000-0000-0000-000000000003', 'marketplace', 'hotel_listings', 'marketplace_listing_casa_daliya', 'listing_input', '{}');

INSERT INTO hotel_catalog.property_slugs
  (id, property_id, slug, locale, purpose, status, redirects_to_id)
VALUES
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'hotel-alpenrose', NULL, 'canonical', 'active', NULL),
  ('c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'alpenrose-old', NULL, 'redirect', 'redirected', 'c2000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000002', 'hidden-bay-villas', NULL, 'canonical', 'active', NULL),
  ('c2000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000003', 'casa-daliya', NULL, 'canonical', 'active', NULL);

INSERT INTO hotel_catalog.property_domains
  (id, property_id, hostname, verification_status, canonical_when_verified, verified_at)
VALUES
  ('c3000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', 'stay.casadaliya.example', 'verified', TRUE, '2026-06-06T10:00:00Z');

INSERT INTO hotel_catalog.property_locations
  (property_id, country_code, region, city, street_address, postal_code, raw_marketplace_location, latitude, longitude, timezone, address_public, geo_public, map_display_mode, source_confidence, migration_notes)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'AT', 'Tyrol', 'Mayrhofen', 'Alpenroseweg 7', '6290', NULL, 47.166100, 11.865900, 'Europe/Vienna', TRUE, TRUE, 'exact', 'verified', NULL),
  ('c1000000-0000-0000-0000-000000000002', NULL, NULL, NULL, NULL, NULL, 'Somewhere near the bay', NULL, NULL, NULL, FALSE, FALSE, 'hidden', 'low', 'Marketplace free-form location preserved for manual reconciliation.'),
  ('c1000000-0000-0000-0000-000000000003', 'MX', 'Quintana Roo', 'Isla Mujeres', 'Calle Zazil Ha 12', '77400', NULL, 21.257300, -86.751800, 'America/Cancun', TRUE, TRUE, 'exact', 'verified', NULL);

INSERT INTO hotel_catalog.property_profiles
  (property_id, locale, short_description, long_description, source_confidence)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'en', 'Alpine boutique stay with mountain views.', 'A public-safe profile assembled from Booking, PMS, and Marketplace seed copy.', 'verified'),
  ('c1000000-0000-0000-0000-000000000002', 'en', 'Private villas near the coast.', 'Location is intentionally incomplete until owner confirmation.', 'medium'),
  ('c1000000-0000-0000-0000-000000000003', 'en', 'Island villa with verified direct booking domain.', 'Custom-domain profile fixture for canonical URL consumers.', 'verified');

INSERT INTO hotel_catalog.property_media
  (property_id, media_type, url, alt_text, sort_order, source_system, public_approved)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'hero_image', 'https://cdn.example.test/alpenrose/hero.jpg', 'Hotel Alpenrose exterior', 0, 'booking', TRUE),
  ('c1000000-0000-0000-0000-000000000002', 'hero_image', 'https://cdn.example.test/hidden-bay/hero.jpg', 'Hidden Bay Villas garden', 0, 'marketplace', TRUE),
  ('c1000000-0000-0000-0000-000000000003', 'hero_image', 'https://cdn.example.test/casa-daliya/hero.jpg', 'Casa Daliya terrace', 0, 'booking', TRUE);

INSERT INTO hotel_catalog.property_amenities
  (property_id, amenity_key, label, source_system, public_safe)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'wifi', 'Wi-Fi', 'booking', TRUE),
  ('c1000000-0000-0000-0000-000000000001', 'breakfast', 'Breakfast', 'pms', TRUE),
  ('c1000000-0000-0000-0000-000000000002', 'pool', 'Pool', 'marketplace', TRUE),
  ('c1000000-0000-0000-0000-000000000003', 'beach_access', 'Beach access', 'booking', TRUE);

INSERT INTO hotel_catalog.property_contact_channels
  (property_id, channel_type, value, is_public, source_system)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'email', 'stay@hotel-alpenrose.example', TRUE, 'booking'),
  ('c1000000-0000-0000-0000-000000000003', 'website', 'https://stay.casadaliya.example', TRUE, 'booking');

INSERT INTO hotel_catalog.property_policy_summaries
  (property_id, check_in_time, check_out_time, cancellation_summary, cancellation_terms_url, deposit_policy_summary, payment_policy_summary, policy_source_owner)
VALUES
  ('c1000000-0000-0000-0000-000000000001', '15:00', '11:00', 'Flexible cancellation until 7 days before arrival.', 'https://hotel-alpenrose.booking.localhost/en/terms', 'Deposit may be required for selected rates.', 'Card and pay-at-property supported.', 'booking'),
  ('c1000000-0000-0000-0000-000000000002', NULL, NULL, NULL, NULL, NULL, NULL, 'booking'),
  ('c1000000-0000-0000-0000-000000000003', '16:00', '10:00', 'Moderate cancellation policy.', 'https://stay.casadaliya.example/en/terms', '50% deposit required.', 'Card payments supported.', 'booking');

INSERT INTO hotel_catalog.property_public_profile_read_model
  (property_id, public_id, display_name, canonical_slug, property_domain_id, verified_custom_domain, default_locale, supported_locales, profile_status, completeness_reasons, location, descriptions, media, amenities, public_contacts, public_policy, source_freshness)
VALUES
  (
    'c1000000-0000-0000-0000-000000000001',
    'prop_hotel_alpenrose',
    'Hotel Alpenrose',
    'hotel-alpenrose',
    NULL,
    NULL,
    'en',
    ARRAY['en', 'de'],
    'complete',
    '{}',
    '{"countryCode": "AT", "city": "Mayrhofen", "timezone": "Europe/Vienna", "geo": {"latitude": 47.1661, "longitude": 11.8659}}',
    '{"en": {"short": "Alpine boutique stay with mountain views."}}',
    '[{"type": "hero_image", "url": "https://cdn.example.test/alpenrose/hero.jpg"}]',
    '[{"key": "wifi", "label": "Wi-Fi"}, {"key": "breakfast", "label": "Breakfast"}]',
    '[{"type": "email", "value": "stay@hotel-alpenrose.example"}]',
    '{"checkInTime": "15:00", "checkOutTime": "11:00"}',
    '{"hotel_catalog": {"status": "fresh"}, "booking": {"status": "fresh"}, "pms": {"status": "fresh"}, "marketplace": {"status": "fresh"}}'
  ),
  (
    'c1000000-0000-0000-0000-000000000002',
    'prop_hidden_bay',
    'Hidden Bay Villas',
    'hidden-bay-villas',
    NULL,
    NULL,
    'en',
    ARRAY['en'],
    'incomplete',
    ARRAY['location_unverified', 'timezone_missing'],
    '{"rawMarketplaceLocation": "Somewhere near the bay"}',
    '{"en": {"short": "Private villas near the coast."}}',
    '[{"type": "hero_image", "url": "https://cdn.example.test/hidden-bay/hero.jpg"}]',
    '[{"key": "pool", "label": "Pool"}]',
    '[]',
    '{}',
    '{"hotel_catalog": {"status": "stale"}, "marketplace": {"status": "fresh"}}'
  ),
  (
    'c1000000-0000-0000-0000-000000000003',
    'prop_casa_daliya',
    'Casa Daliya',
    'casa-daliya',
    'c3000000-0000-0000-0000-000000000003',
    'stay.casadaliya.example',
    'en',
    ARRAY['en', 'es'],
    'complete',
    '{}',
    '{"countryCode": "MX", "city": "Isla Mujeres", "timezone": "America/Cancun", "geo": {"latitude": 21.2573, "longitude": -86.7518}}',
    '{"en": {"short": "Island villa with verified direct booking domain."}}',
    '[{"type": "hero_image", "url": "https://cdn.example.test/casa-daliya/hero.jpg"}]',
    '[{"key": "beach_access", "label": "Beach access"}]',
    '[{"type": "website", "value": "https://stay.casadaliya.example"}]',
    '{"checkInTime": "16:00", "checkOutTime": "10:00"}',
    '{"hotel_catalog": {"status": "fresh"}, "booking": {"status": "fresh"}, "pms": {"status": "fresh"}, "marketplace": {"status": "fresh"}}'
  );
