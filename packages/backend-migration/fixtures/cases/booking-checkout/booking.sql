-- Fixture: booking-checkout / booking.sql
-- Target: identity, hotel_catalog, booking, and finance schemas.
--
-- This parity-only fixture inserts already-migrated target rows. There is no
-- source-to-target transform handler for this case.

INSERT INTO identity.users
  (id, email, name, status)
VALUES
  ('d1000000-0000-0000-0000-000000000682', 'owner.checkout@example.test', 'Checkout Owner', 'active');

INSERT INTO identity.organizations
  (id, kind, name, slug, status, workos_org_id, workos_external_id)
VALUES
  ('d2000000-0000-0000-0000-000000000682', 'hotel_group', 'Checkout Alpenrose Group', 'checkout-alpenrose-group', 'active', 'org_checkout_alpenrose', 'checkout-alpenrose-group');

INSERT INTO identity.organization_memberships
  (id, organization_id, user_id, status, role_key, workos_membership_id, workos_role_slugs)
VALUES
  ('d2100000-0000-0000-0000-000000000682', 'd2000000-0000-0000-0000-000000000682', 'd1000000-0000-0000-0000-000000000682', 'active', 'hotel_owner', 'membership_checkout_owner', ARRAY['hotel_owner']);

INSERT INTO identity.organization_resource_links
  (id, organization_id, product, resource_type, resource_id, relationship, status)
VALUES
  ('d2200000-0000-0000-0000-000000000682', 'd2000000-0000-0000-0000-000000000682', 'booking', 'booking_hotel', 'booking_hotel_checkout_alpenrose', 'owner', 'active');

INSERT INTO identity.product_entitlements
  (id, organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id, starts_at, metadata)
VALUES
  ('d2300000-0000-0000-0000-000000000682', 'd2000000-0000-0000-0000-000000000682', 'booking', 'booking-engine', 'active', 'booking', 'booking_hotel', 'booking_hotel_checkout_alpenrose', '2026-06-01T00:00:00Z', '{"fixture": "booking-checkout"}');

INSERT INTO hotel_catalog.properties
  (id, public_id, display_name, property_type, category, default_locale, supported_locales, profile_status, completeness_reasons)
VALUES
  ('d3000000-0000-0000-0000-000000000682', 'prop_checkout_alpenrose', 'Checkout Alpenrose', 'hotel', 'boutique', 'en', ARRAY['en', 'de'], 'complete', '{}');

INSERT INTO hotel_catalog.property_source_links
  (id, property_id, source_system, source_table, source_id, relationship, metadata)
VALUES
  ('d3100000-0000-0000-0000-000000000682', 'd3000000-0000-0000-0000-000000000682', 'booking', 'booking_hotels', 'booking_hotel_checkout_alpenrose', 'canonical_input', '{"fixture": "booking-checkout"}');

INSERT INTO hotel_catalog.property_slugs
  (id, property_id, slug, locale, purpose, status)
VALUES
  ('d3200000-0000-0000-0000-000000000682', 'd3000000-0000-0000-0000-000000000682', 'checkout-alpenrose', NULL, 'canonical', 'active');

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
    'd4000000-0000-0000-0000-000000000682',
    'd3000000-0000-0000-0000-000000000682',
    'checkout-fixture-2026-07-01-2026-07-04-2-1',
    'Q-CHK-682',
    '2026-07-01',
    '2026-07-04',
    2,
    1,
    1,
    'EUR',
    'converted',
    '{"roomOfferId": "offer_alpine_suite", "roomTypeId": "room_type_alpine_suite", "ratePlanId": "direct_flexible", "nights": 3}',
    '{"currency": "EUR", "roomTotal": "450.00", "discount": "30.00", "total": "420.00", "depositDue": "126.00"}',
    '{"cancellation": "Flexible until 7 days before arrival.", "payment": "Card charged at checkout."}',
    '{"booking": {"status": "fresh", "generatedAt": "2026-06-09T08:00:00Z"}}',
    'SUMMER30',
    'creator_ref_682',
    '2026-06-10T08:00:00Z',
    '2026-06-09T08:00:00Z',
    '2026-06-09T08:05:00Z'
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
    'd5000000-0000-0000-0000-000000000682',
    'd4000000-0000-0000-0000-000000000682',
    'd3000000-0000-0000-0000-000000000682',
    'en',
    'EUR',
    'converted',
    '{"booker": {"firstName": "Mira", "lastName": "Guest", "email": "mira.guest@example.test"}, "arrivalTime": "18:00"}',
    '[{"addonDefinitionId": "d8000000-0000-0000-0000-000000000682", "quantity": 1}]',
    '{"provider": "stripe", "paymentIntentId": "pi_checkout_fixture_682"}',
    '{"promoCode": "SUMMER30", "discountAmount": "30.00"}',
    '2026-06-10T08:00:00Z',
    '2026-06-09T08:01:00Z',
    '2026-06-09T08:06:00Z'
  );

INSERT INTO booking.guest_bookings
  (
    id,
    property_id,
    quote_session_id,
    checkout_context_id,
    public_reference,
    source_system,
    source_booking_id,
    lifecycle_status,
    payment_status,
    check_in,
    check_out,
    adults,
    children,
    room_count,
    currency,
    total_amount,
    balance_amount,
    booking_metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'd6000000-0000-0000-0000-000000000682',
    'd3000000-0000-0000-0000-000000000682',
    'd4000000-0000-0000-0000-000000000682',
    'd5000000-0000-0000-0000-000000000682',
    'B-CHK-682',
    'booking',
    NULL,
    'confirmed',
    'paid',
    '2026-07-01',
    '2026-07-04',
    2,
    1,
    1,
    'EUR',
    420.00,
    0.00,
    '{"fixture": "booking-checkout", "publicQuoteReference": "Q-CHK-682"}',
    '2026-06-09T08:06:00Z',
    '2026-06-09T08:10:00Z'
  );

INSERT INTO booking.booking_guests
  (id, guest_booking_id, guest_role, first_name, last_name, email, phone, country_code, arrival_time, special_requests, pii_retention_until)
VALUES
  ('d7000000-0000-0000-0000-000000000682', 'd6000000-0000-0000-0000-000000000682', 'booker', 'Mira', 'Guest', 'mira.guest@example.test', '+4312345678', 'AT', '18:00', 'Gluten-free breakfast if available.', '2027-07-04'),
  ('d7100000-0000-0000-0000-000000000682', 'd6000000-0000-0000-0000-000000000682', 'additional_guest', 'Leo', 'Guest', NULL, NULL, 'AT', NULL, NULL, '2027-07-04');

INSERT INTO booking.addon_definitions
  (id, property_id, source_system, source_addon_id, name, description, category, pricing_model, price_amount, currency, public_visible, status, metadata)
VALUES
  ('d8000000-0000-0000-0000-000000000682', 'd3000000-0000-0000-0000-000000000682', 'booking', 'addon_breakfast_checkout_682', 'Breakfast basket', 'Breakfast delivered each morning.', 'food', 'per_stay', 45.00, 'EUR', TRUE, 'active', '{"fixture": "booking-checkout"}');

INSERT INTO booking.booking_addon_selections
  (id, property_id, guest_booking_id, quote_session_id, addon_definition_id, addon_snapshot, quantity, service_date, total_amount, currency)
VALUES
  ('d8100000-0000-0000-0000-000000000682', 'd3000000-0000-0000-0000-000000000682', 'd6000000-0000-0000-0000-000000000682', NULL, 'd8000000-0000-0000-0000-000000000682', '{"name": "Breakfast basket", "pricingModel": "per_stay"}', 1, '2026-07-02', 45.00, 'EUR');

INSERT INTO booking.promo_applications
  (id, property_id, quote_session_id, guest_booking_id, promo_code, application_status, discount_amount, currency, metadata)
VALUES
  ('d9000000-0000-0000-0000-000000000682', 'd3000000-0000-0000-0000-000000000682', NULL, 'd6000000-0000-0000-0000-000000000682', 'SUMMER30', 'applied', 30.00, 'EUR', '{"source": "quote"}');

INSERT INTO booking.booking_status_events
  (id, guest_booking_id, event_type, from_status, to_status, actor_type, actor_user_id, public_visible, public_message, event_payload, occurred_at)
VALUES
  ('e3000000-0000-0000-0000-000000000682', 'd6000000-0000-0000-0000-000000000682', 'booking_created', NULL, 'pending_payment', 'guest', NULL, TRUE, 'Booking request received.', '{"checkoutContextId": "d5000000-0000-0000-0000-000000000682"}', '2026-06-09T08:06:00Z'),
  ('e3100000-0000-0000-0000-000000000682', 'd6000000-0000-0000-0000-000000000682', 'payment_captured', 'pending_payment', 'confirmed', 'system', NULL, TRUE, 'Payment received and booking confirmed.', '{"paymentId": "e2000000-0000-0000-0000-000000000682"}', '2026-06-09T08:09:00Z');

INSERT INTO booking.booking_change_requests
  (id, guest_booking_id, request_type, requested_by, status, requested_changes, created_at, updated_at)
VALUES
  ('e4000000-0000-0000-0000-000000000682', 'd6000000-0000-0000-0000-000000000682', 'date_change', 'guest', 'pending', '{"requestedCheckOut": "2026-07-05"}', '2026-06-09T09:00:00Z', '2026-06-09T09:00:00Z');

INSERT INTO booking.booking_notes_public
  (id, guest_booking_id, author_type, author_user_id, body, locale, created_at)
VALUES
  ('e5000000-0000-0000-0000-000000000682', 'd6000000-0000-0000-0000-000000000682', 'system', NULL, 'Payment received. We will see you soon.', 'en', '2026-06-09T08:10:00Z');

INSERT INTO booking.direct_booking_summary_read_model
  (
    guest_booking_id,
    property_id,
    public_reference,
    lifecycle_status,
    payment_status,
    check_in,
    check_out,
    guest_counts,
    room_summary,
    amount_summary,
    public_policy,
    source_freshness,
    projected_at
  )
VALUES
  (
    'd6000000-0000-0000-0000-000000000682',
    'd3000000-0000-0000-0000-000000000682',
    'B-CHK-682',
    'confirmed',
    'paid',
    '2026-07-01',
    '2026-07-04',
    '{"adults": 2, "children": 1, "roomCount": 1}',
    '{"roomType": "Alpine Suite", "nights": 3}',
    '{"currency": "EUR", "total": "420.00", "balance": "0.00", "paid": "420.00"}',
    '{"cancellation": "Flexible until 7 days before arrival."}',
    '{"booking": {"status": "fresh"}, "finance": {"status": "fresh"}}',
    '2026-06-09T08:10:00Z'
  );

INSERT INTO finance.payment_provider_accounts
  (id, property_id, account_scope, provider, provider_account_id, status, onboarding_status, charges_enabled, payouts_enabled, default_currency, capabilities, account_metadata)
VALUES
  ('e1000000-0000-0000-0000-000000000682', 'd3000000-0000-0000-0000-000000000682', 'property', 'stripe', 'acct_checkout_fixture_682', 'active', 'completed', TRUE, TRUE, 'EUR', ARRAY['card_payments', 'transfers'], '{"fixture": "booking-checkout"}');

INSERT INTO finance.payment_settings
  (property_id, provider_account_id, payments_enabled, accepted_methods, default_currency, deposit_policy, refund_policy, tax_policy, statement_descriptor, source_system, source_settings_id)
VALUES
  ('d3000000-0000-0000-0000-000000000682', 'e1000000-0000-0000-0000-000000000682', TRUE, ARRAY['card', 'pay_at_property'], 'EUR', '{"depositPercent": 30}', '{"refundWindowDays": 7}', '{"taxIncluded": true}', 'CHECKOUTALPENROSE', 'booking', 'booking_payment_settings_checkout_682');

INSERT INTO finance.payments
  (
    id,
    property_id,
    organization_id,
    guest_booking_id,
    provider_account_id,
    source_system,
    source_payment_id,
    idempotency_key,
    payment_kind,
    payment_method,
    status,
    amount,
    fee_amount,
    net_amount,
    refunded_amount,
    currency,
    provider_transaction_id,
    provider_payment_intent_id,
    visibility_class,
    authorized_at,
    paid_at,
    pii_retention_until,
    payment_metadata
  )
VALUES
  (
    'e2000000-0000-0000-0000-000000000682',
    'd3000000-0000-0000-0000-000000000682',
    'd2000000-0000-0000-0000-000000000682',
    'd6000000-0000-0000-0000-000000000682',
    'e1000000-0000-0000-0000-000000000682',
    'booking',
    'booking_payment_checkout_682',
    'booking-checkout-682-payment',
    'full',
    'card',
    'paid',
    420.00,
    12.60,
    407.40,
    0.00,
    'EUR',
    'txn_checkout_fixture_682',
    'pi_checkout_fixture_682',
    'pms_finance',
    '2026-06-09T08:08:00Z',
    '2026-06-09T08:09:00Z',
    '2027-07-04',
    '{"publicReference": "B-CHK-682"}'
  );
