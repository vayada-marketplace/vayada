-- Fixture: finance / finance.sql
-- Target: identity, hotel_catalog, booking, and finance schemas.
--
-- This parity-only fixture inserts already-migrated target rows. There is no
-- source-to-target transform handler for this case.

INSERT INTO identity.users
  (id, email, name, status)
VALUES
  ('f1000000-0000-0000-0000-000000000686', 'owner.finance@example.test', 'Finance Owner', 'active'),
  ('f1000000-0000-0000-0000-000000000687', 'affiliate.finance@example.test', 'Finance Affiliate', 'active');

INSERT INTO identity.organizations
  (id, kind, name, slug, status, workos_org_id, workos_external_id)
VALUES
  ('f2000000-0000-0000-0000-000000000686', 'hotel_group', 'Finance Alpenrose Group', 'finance-alpenrose-group', 'active', 'org_finance_alpenrose', 'finance-alpenrose-group'),
  ('f2000000-0000-0000-0000-000000000687', 'affiliate_partner', 'Finance Affiliate Partner', 'finance-affiliate-partner', 'active', 'org_finance_affiliate', 'finance-affiliate-partner');

INSERT INTO identity.organization_memberships
  (id, organization_id, user_id, status, role_key, workos_membership_id, workos_role_slugs)
VALUES
  ('f2100000-0000-0000-0000-000000000686', 'f2000000-0000-0000-0000-000000000686', 'f1000000-0000-0000-0000-000000000686', 'active', 'hotel_owner', 'membership_finance_owner', ARRAY['hotel_owner']),
  ('f2100000-0000-0000-0000-000000000687', 'f2000000-0000-0000-0000-000000000687', 'f1000000-0000-0000-0000-000000000687', 'active', 'affiliate_owner', 'membership_finance_affiliate', ARRAY['affiliate_owner']);

INSERT INTO identity.organization_resource_links
  (id, organization_id, product, resource_type, resource_id, relationship, status)
VALUES
  ('f2200000-0000-0000-0000-000000000686', 'f2000000-0000-0000-0000-000000000686', 'booking', 'booking_hotel', 'booking_hotel_finance_alpenrose', 'owner', 'active'),
  ('f2200000-0000-0000-0000-000000000687', 'f2000000-0000-0000-0000-000000000686', 'pms', 'pms_hotel', 'pms_hotel_finance_alpenrose', 'operator', 'active'),
  ('f2200000-0000-0000-0000-000000000688', 'f2000000-0000-0000-0000-000000000687', 'affiliate', 'affiliate', 'affiliate_finance_partner_686', 'promotes', 'active');

INSERT INTO identity.product_entitlements
  (id, organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id, starts_at, metadata)
VALUES
  ('f2300000-0000-0000-0000-000000000686', 'f2000000-0000-0000-0000-000000000686', 'pms', 'pms-core', 'active', 'pms', 'pms_hotel', 'pms_hotel_finance_alpenrose', '2026-06-01T00:00:00Z', '{"fixture": "finance"}'),
  ('f2310000-0000-0000-0000-000000000686', 'f2000000-0000-0000-0000-000000000686', 'booking', 'booking-engine', 'active', 'booking', 'booking_hotel', 'booking_hotel_finance_alpenrose', '2026-06-01T00:00:00Z', '{"fixture": "finance"}'),
  ('f2320000-0000-0000-0000-000000000686', 'f2000000-0000-0000-0000-000000000687', 'affiliate', 'affiliate-payouts', 'active', 'affiliate', 'affiliate', 'affiliate_finance_partner_686', '2026-06-01T00:00:00Z', '{"fixture": "finance"}');

INSERT INTO hotel_catalog.properties
  (id, public_id, display_name, property_type, category, default_locale, supported_locales, profile_status, completeness_reasons)
VALUES
  ('f3000000-0000-0000-0000-000000000686', 'prop_finance_alpenrose', 'Finance Alpenrose', 'hotel', 'boutique', 'en', ARRAY['en', 'de'], 'complete', '{}');

INSERT INTO hotel_catalog.property_source_links
  (id, property_id, source_system, source_table, source_id, relationship, metadata)
VALUES
  ('f3100000-0000-0000-0000-000000000686', 'f3000000-0000-0000-0000-000000000686', 'booking', 'booking_hotels', 'booking_hotel_finance_alpenrose', 'canonical_input', '{"fixture": "finance"}'),
  ('f3100000-0000-0000-0000-000000000687', 'f3000000-0000-0000-0000-000000000686', 'pms', 'hotels', 'pms_hotel_finance_alpenrose', 'operational_input', '{"fixture": "finance"}');

INSERT INTO hotel_catalog.property_slugs
  (id, property_id, slug, locale, purpose, status)
VALUES
  ('f3200000-0000-0000-0000-000000000686', 'f3000000-0000-0000-0000-000000000686', 'finance-alpenrose', NULL, 'canonical', 'active');

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
    expires_at,
    created_at,
    updated_at
  )
VALUES
  (
    'f4000000-0000-0000-0000-000000000686',
    'f3000000-0000-0000-0000-000000000686',
    'finance-fixture-2026-08-01-2026-08-05-2-0',
    'Q-FIN-686',
    '2026-08-01',
    '2026-08-05',
    2,
    0,
    1,
    'EUR',
    'converted',
    '{"roomOfferId": "offer_finance_suite", "roomTypeId": "room_type_finance_suite", "ratePlanId": "direct_flexible", "nights": 4}',
    '{"currency": "EUR", "roomTotal": "1200.00", "total": "1200.00", "depositDue": "360.00"}',
    '{"cancellation": "Flexible until 14 days before arrival.", "payment": "Card charged at checkout."}',
    '{"booking": {"status": "fresh", "generatedAt": "2026-06-09T08:00:00Z"}}',
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
    payment_context,
    expires_at,
    created_at,
    updated_at
  )
VALUES
  (
    'f5000000-0000-0000-0000-000000000686',
    'f4000000-0000-0000-0000-000000000686',
    'f3000000-0000-0000-0000-000000000686',
    'en',
    'EUR',
    'converted',
    '{"booker": {"firstName": "Fi", "lastName": "Guest", "email": "finance.guest@example.test"}}',
    '{"provider": "stripe", "paymentIntentId": "pi_finance_fixture_686"}',
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
    'f6000000-0000-0000-0000-000000000686',
    'f3000000-0000-0000-0000-000000000686',
    'f4000000-0000-0000-0000-000000000686',
    'f5000000-0000-0000-0000-000000000686',
    'B-FIN-686',
    'booking',
    NULL,
    'confirmed',
    'paid',
    '2026-08-01',
    '2026-08-05',
    2,
    0,
    1,
    'EUR',
    1200.00,
    0.00,
    '{"fixture": "finance", "publicQuoteReference": "Q-FIN-686"}',
    '2026-06-09T08:06:00Z',
    '2026-06-09T08:10:00Z'
  );

INSERT INTO finance.payment_provider_accounts
  (
    id,
    property_id,
    organization_id,
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
    'f7000000-0000-0000-0000-000000000686',
    'f3000000-0000-0000-0000-000000000686',
    NULL,
    'property',
    'stripe',
    'acct_finance_property_686',
    'active',
    'completed',
    TRUE,
    TRUE,
    'EUR',
    ARRAY['card_payments', 'transfers'],
    '{"fixture": "finance", "providerPaymentIntentId": "pi_finance_fixture_686"}',
    'secret_ref_finance_property_686'
  ),
  (
    'f7100000-0000-0000-0000-000000000686',
    NULL,
    'f2000000-0000-0000-0000-000000000687',
    'organization',
    'paypal',
    'acct_finance_affiliate_686',
    'active',
    'completed',
    FALSE,
    TRUE,
    'EUR',
    ARRAY['transfers'],
    '{"fixture": "finance"}',
    'secret_ref_finance_affiliate_686'
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
    'f3000000-0000-0000-0000-000000000686',
    'f7000000-0000-0000-0000-000000000686',
    TRUE,
    ARRAY['card', 'pay_at_property'],
    'EUR',
    '{"depositPercent": 30}',
    '{"refundWindowDays": 14}',
    '{"taxIncluded": true}',
    'FINANCEALPENROSE',
    'booking',
    'booking_payment_settings_finance_686'
  );

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
    processor_fee_breakdown,
    risk_review,
    payment_metadata,
    visibility_class,
    authorized_at,
    paid_at,
    pii_retention_until
  )
VALUES
  (
    'f8000000-0000-0000-0000-000000000686',
    'f3000000-0000-0000-0000-000000000686',
    'f2000000-0000-0000-0000-000000000686',
    'f6000000-0000-0000-0000-000000000686',
    'f7000000-0000-0000-0000-000000000686',
    'booking',
    'booking_payment_finance_686',
    'finance-686-payment',
    'full',
    'card',
    'paid',
    1200.00,
    36.00,
    1164.00,
    0.00,
    'EUR',
    'txn_finance_fixture_686',
    'pi_finance_fixture_686',
    '{"stripeFee": "36.00"}',
    '{"riskScore": "low"}',
    '{"publicReference": "B-FIN-686", "guestEmail": "finance.guest@example.test"}',
    'pms_finance',
    '2026-06-09T08:08:00Z',
    '2026-06-09T08:09:00Z',
    '2027-08-05'
  );

INSERT INTO finance.payout_settings
  (
    id,
    property_id,
    organization_id,
    property_provider_account_id,
    organization_provider_account_id,
    owner_scope,
    payout_method,
    destination_country_code,
    default_currency,
    status,
    schedule,
    payout_preferences,
    sensitive_destination_ref,
    source_system,
    source_settings_id
  )
VALUES
  (
    'f9000000-0000-0000-0000-000000000686',
    'f3000000-0000-0000-0000-000000000686',
    NULL,
    'f7000000-0000-0000-0000-000000000686',
    NULL,
    'property',
    'bank_account',
    'AT',
    'EUR',
    'active',
    '{"frequency": "weekly", "weekday": "monday"}',
    '{"minimumAmount": "100.00"}',
    'bank_ref_finance_property_686',
    'pms',
    'pms_payout_settings_finance_686'
  ),
  (
    'f9100000-0000-0000-0000-000000000686',
    NULL,
    'f2000000-0000-0000-0000-000000000687',
    NULL,
    'f7100000-0000-0000-0000-000000000686',
    'organization',
    'paypal',
    'AT',
    'EUR',
    'active',
    '{"frequency": "monthly"}',
    '{"minimumAmount": "50.00"}',
    'bank_ref_finance_affiliate_686',
    'marketplace',
    'marketplace_affiliate_payout_settings_686'
  );

INSERT INTO finance.payouts
  (
    id,
    payout_setting_id,
    payment_id,
    guest_booking_id,
    property_provider_account_id,
    organization_provider_account_id,
    owner_scope,
    property_id,
    organization_id,
    related_property_id,
    source_system,
    source_payout_id,
    payout_status,
    amount,
    fee_amount,
    net_amount,
    currency,
    period_start,
    period_end,
    provider_payout_id,
    scheduled_at,
    paid_at,
    payout_metadata
  )
VALUES
  (
    'fa000000-0000-0000-0000-000000000686',
    'f9000000-0000-0000-0000-000000000686',
    'f8000000-0000-0000-0000-000000000686',
    'f6000000-0000-0000-0000-000000000686',
    'f7000000-0000-0000-0000-000000000686',
    NULL,
    'property',
    'f3000000-0000-0000-0000-000000000686',
    NULL,
    'f3000000-0000-0000-0000-000000000686',
    'pms',
    'pms_payout_finance_686',
    'paid',
    1164.00,
    5.00,
    1159.00,
    'EUR',
    '2026-06-09',
    '2026-06-09',
    'po_finance_property_686',
    '2026-06-10T08:00:00Z',
    '2026-06-10T12:00:00Z',
    '{"fixture": "finance"}'
  ),
  (
    'fa100000-0000-0000-0000-000000000686',
    'f9100000-0000-0000-0000-000000000686',
    NULL,
    NULL,
    NULL,
    'f7100000-0000-0000-0000-000000000686',
    'organization',
    NULL,
    'f2000000-0000-0000-0000-000000000687',
    NULL,
    'marketplace',
    'marketplace_affiliate_payout_686',
    'paid',
    250.00,
    0.00,
    250.00,
    'EUR',
    '2026-06-01',
    '2026-06-30',
    'po_finance_affiliate_686',
    '2026-07-01T08:00:00Z',
    '2026-07-01T12:00:00Z',
    '{"fixture": "finance", "resourceId": "affiliate_finance_partner_686"}'
  );

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
    'fb000000-0000-0000-0000-000000000686',
    'f3000000-0000-0000-0000-000000000686',
    NULL,
    'property',
    'booking',
    'percentage',
    12.5000,
    'EUR',
    'active',
    '2026-06-01T00:00:00Z',
    'booking',
    'booking_commission_rule_finance_686',
    '{"fixture": "finance", "source": "booking"}'
  );

INSERT INTO finance.commission_rate_changes
  (
    id,
    commission_rule_id,
    changed_by_user_id,
    previous_percentage_rate,
    new_percentage_rate,
    currency,
    reason,
    effective_at,
    changed_at,
    change_metadata
  )
VALUES
  (
    'fb100000-0000-0000-0000-000000000686',
    'fb000000-0000-0000-0000-000000000686',
    'f1000000-0000-0000-0000-000000000686',
    10.0000,
    12.5000,
    'EUR',
    'Finance fixture validates commission audit trail.',
    '2026-06-01T00:00:00Z',
    '2026-06-09T08:00:00Z',
    '{"fixture": "finance"}'
  );

INSERT INTO finance.billing_entitlements
  (
    id,
    organization_id,
    property_id,
    identity_entitlement_id,
    product,
    entitlement_key,
    billing_status,
    plan_key,
    seat_count,
    billing_provider,
    billing_customer_ref,
    billing_subscription_ref,
    billing_period_start,
    billing_period_end,
    starts_at,
    source_system,
    source_entitlement_id,
    entitlement_metadata
  )
VALUES
  (
    'fc000000-0000-0000-0000-000000000686',
    'f2000000-0000-0000-0000-000000000686',
    'f3000000-0000-0000-0000-000000000686',
    'f2300000-0000-0000-0000-000000000686',
    'pms',
    'pms-core',
    'active',
    'pms-pro',
    3,
    'stripe',
    'cus_finance_property_686',
    'sub_finance_property_686',
    '2026-06-01',
    '2026-06-30',
    '2026-06-01T00:00:00Z',
    'pms',
    'pms_entitlement_finance_686',
    '{"fixture": "finance", "resource": "property"}'
  ),
  (
    'fc100000-0000-0000-0000-000000000686',
    'f2000000-0000-0000-0000-000000000687',
    NULL,
    'f2320000-0000-0000-0000-000000000686',
    'affiliate',
    'affiliate-payouts',
    'active',
    'affiliate-standard',
    1,
    'manual',
    NULL,
    NULL,
    '2026-06-01',
    '2026-06-30',
    '2026-06-01T00:00:00Z',
    'marketplace',
    'affiliate_entitlement_finance_686',
    '{"fixture": "finance", "resource": "affiliate_finance_partner_686"}'
  );

INSERT INTO finance.finance_visibility_read_model
  (
    id,
    organization_id,
    property_id,
    visibility_scope,
    resource_type,
    resource_id,
    required_permission_key,
    period_start,
    period_end,
    currency,
    gross_payment_amount,
    net_payment_amount,
    payout_amount,
    commission_amount,
    outstanding_balance_amount,
    payment_count,
    payout_count,
    failed_payment_count,
    entitlement_status,
    status_counts,
    entitlement_summary,
    source_freshness,
    projected_at
  )
VALUES
  (
    'fd000000-0000-0000-0000-000000000686',
    'f2000000-0000-0000-0000-000000000686',
    'f3000000-0000-0000-0000-000000000686',
    'property_finance',
    'property',
    'f3000000-0000-0000-0000-000000000686',
    'pms.finance.read',
    '2026-06-01',
    '2026-06-30',
    'EUR',
    1200.00,
    1164.00,
    1164.00,
    150.00,
    0.00,
    1,
    1,
    0,
    'active',
    '{"payments": {"paid": 1}, "payouts": {"paid": 1}}',
    '{"planKey": "pms-pro", "billingStatus": "active"}',
    '{"finance": {"status": "fresh", "projectedAt": "2026-06-09T09:00:00Z"}}',
    '2026-06-09T09:00:00Z'
  ),
  (
    'fd100000-0000-0000-0000-000000000686',
    'f2000000-0000-0000-0000-000000000687',
    NULL,
    'affiliate_payout',
    'affiliate',
    'affiliate_finance_partner_686',
    'affiliate.payout.manage',
    '2026-06-01',
    '2026-06-30',
    'EUR',
    0.00,
    0.00,
    250.00,
    0.00,
    0.00,
    0,
    1,
    0,
    'active',
    '{"payouts": {"paid": 1}}',
    '{"planKey": "affiliate-standard", "billingStatus": "active"}',
    '{"finance": {"status": "fresh", "projectedAt": "2026-06-09T09:00:00Z"}}',
    '2026-06-09T09:00:00Z'
  );
