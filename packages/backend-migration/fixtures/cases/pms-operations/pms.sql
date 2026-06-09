-- Fixture: pms-operations / pms.sql
-- Target: identity, hotel_catalog, booking, and pms schemas.
--
-- This parity-only fixture inserts already-migrated target rows. There is no
-- source-to-target transform handler for this case.

INSERT INTO identity.users
  (id, email, name, status)
VALUES
  ('f6851000-0000-0000-0000-000000000001', 'ops.owner@example.test', 'Operations Owner', 'active');

INSERT INTO identity.organizations
  (id, kind, name, slug, status, workos_org_id, workos_external_id)
VALUES
  ('f6852000-0000-0000-0000-000000000001', 'hotel_group', 'PMS Operations Alpenrose Group', 'pms-operations-alpenrose-group', 'active', 'org_pms_operations_alpenrose', 'pms-operations-alpenrose-group');

INSERT INTO identity.organization_memberships
  (id, organization_id, user_id, status, role_key, workos_membership_id, workos_role_slugs)
VALUES
  ('f6852100-0000-0000-0000-000000000001', 'f6852000-0000-0000-0000-000000000001', 'f6851000-0000-0000-0000-000000000001', 'active', 'hotel_owner', 'membership_pms_ops_owner', ARRAY['hotel_owner']);

INSERT INTO identity.organization_resource_links
  (id, organization_id, product, resource_type, resource_id, relationship, status)
VALUES
  ('f6852200-0000-0000-0000-000000000001', 'f6852000-0000-0000-0000-000000000001', 'pms', 'pms_hotel', 'pms_hotel_ops_alpenrose', 'operator', 'active');

INSERT INTO identity.product_entitlements
  (id, organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id, starts_at, metadata)
VALUES
  ('f6852300-0000-0000-0000-000000000001', 'f6852000-0000-0000-0000-000000000001', 'pms', 'pms-core', 'active', 'pms', 'pms_hotel', 'pms_hotel_ops_alpenrose', '2026-06-01T00:00:00Z', '{"fixture": "pms-operations"}');

INSERT INTO hotel_catalog.properties
  (id, public_id, display_name, property_type, category, default_locale, supported_locales, profile_status, completeness_reasons)
VALUES
  ('f6853000-0000-0000-0000-000000000001', 'prop_pms_ops_alpenrose', 'PMS Operations Alpenrose', 'hotel', 'boutique', 'en', ARRAY['en', 'de'], 'complete', '{}');

INSERT INTO hotel_catalog.property_source_links
  (id, property_id, source_system, source_table, source_id, relationship, metadata)
VALUES
  ('f6853100-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'pms', 'hotels', 'pms_hotel_ops_alpenrose', 'operational_input', '{"fixture": "pms-operations"}');

INSERT INTO hotel_catalog.property_slugs
  (id, property_id, slug, locale, purpose, status)
VALUES
  ('f6853200-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'pms-operations-alpenrose', NULL, 'canonical', 'active');

INSERT INTO booking.guest_bookings
  (
    id,
    property_id,
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
    'f6854000-0000-0000-0000-000000000001',
    'f6853000-0000-0000-0000-000000000001',
    'B-PMS-685',
    'pms',
    'legacy-pms-booking-685',
    'completed',
    'paid',
    '2026-08-15',
    '2026-08-18',
    2,
    0,
    1,
    'EUR',
    780.00,
    0.00,
    '{"fixture": "pms-operations", "source": "legacy-pms"}',
    '2026-06-09T08:00:00Z',
    '2026-08-18T11:15:00Z'
  );

INSERT INTO booking.booking_guests
  (id, guest_booking_id, guest_role, first_name, last_name, email, phone, country_code, pii_retention_until)
VALUES
  ('f6854100-0000-0000-0000-000000000001', 'f6854000-0000-0000-0000-000000000001', 'booker', 'Nora', 'Ops', 'nora.ops@example.test', '+43111222333', 'AT', '2027-08-18');

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
    'f6854000-0000-0000-0000-000000000001',
    'f6853000-0000-0000-0000-000000000001',
    'B-PMS-685',
    'completed',
    'paid',
    '2026-08-15',
    '2026-08-18',
    '{"adults": 2, "children": 0, "roomCount": 1}',
    '{"roomType": "Alpine Suite", "roomNumber": "301", "nights": 3}',
    '{"currency": "EUR", "total": "780.00", "balance": "0.00", "paid": "780.00"}',
    '{"checkout": "Public checkout completed."}',
    '{"pms": {"status": "fresh", "generatedAt": "2026-08-18T11:20:00Z"}}',
    '2026-08-18T11:20:00Z'
  );

INSERT INTO pms.room_types
  (id, property_id, source_system, source_room_type_id, name, description, category, occupancy_limits, room_attributes, amenities_snapshot, base_rate_amount, currency, active, sort_order, location_summary)
VALUES
  ('f6855000-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'migration', 'pms-room-type-suite-685', 'Alpine Suite', 'Large suite with balcony.', 'suite', '{"adults": 2, "children": 1}', '{"bedType": "king"}', '["balcony", "minibar"]', 260.00, 'EUR', TRUE, 1, '{"wing": "north"}'),
  ('f6855000-0000-0000-0000-000000000002', 'f6853000-0000-0000-0000-000000000001', 'migration', 'pms-room-type-double-685', 'Garden Double', 'Double room facing the garden.', 'double', '{"adults": 2, "children": 0}', '{"bedType": "queen"}', '["garden_view"]', 180.00, 'EUR', TRUE, 2, '{"wing": "south"}');

INSERT INTO pms.rooms
  (id, property_id, room_type_id, source_system, source_room_id, room_number, floor, status, sort_order, room_metadata)
VALUES
  ('f6855100-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', 'migration', 'pms-room-301-685', '301', '3', 'available', 1, '{"view": "mountain"}'),
  ('f6855100-0000-0000-0000-000000000002', 'f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', 'migration', 'pms-room-302-685', '302', '3', 'maintenance', 2, '{"view": "mountain"}'),
  ('f6855100-0000-0000-0000-000000000003', 'f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000002', 'migration', 'pms-room-102-685', '102', '1', 'available', 3, '{"view": "garden"}');

INSERT INTO pms.rate_plans
  (id, property_id, room_type_id, code, name, rate_type, meal_plan, payment_policy, deposit_policy, cancellation_policy_snapshot, base_rate_amount, currency, active)
VALUES
  ('f6855200-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', 'DIRECT-FLEX', 'Direct Flexible', 'flexible', 'breakfast', '{"payment": "card_or_property"}', '{"depositPercent": 20}', '{"freeUntilDays": 7}', 260.00, 'EUR', TRUE),
  ('f6855200-0000-0000-0000-000000000002', 'f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000002', 'NRF', 'Non-refundable', 'non_refundable', NULL, '{"payment": "prepaid"}', '{"depositPercent": 100}', '{"refund": "none"}', 165.00, 'EUR', TRUE);

INSERT INTO pms.rate_rules
  (id, property_id, room_type_id, rate_plan_id, rule_type, starts_on, ends_on, days_of_week, min_stay_nights, max_stay_nights, price_delta_amount, rule_payload)
VALUES
  ('f6855300-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', 'f6855200-0000-0000-0000-000000000001', 'season', '2026-08-01', '2026-08-31', ARRAY[1,2,3,4,5,6,0], 2, 7, 40.00, '{"season": "high"}'),
  ('f6855300-0000-0000-0000-000000000002', 'f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000002', 'f6855200-0000-0000-0000-000000000002', 'weekend_surcharge', '2026-08-01', '2026-08-31', ARRAY[5,6], 1, NULL, 25.00, '{"applies": "weekend"}');

INSERT INTO pms.inventory_days
  (property_id, room_type_id, stay_date, total_count, assigned_count, blocked_count, available_count, status, source_freshness)
VALUES
  ('f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', '2026-08-15', 2, 1, 1, 0, 'limited', '{"pms": {"status": "fresh"}}'),
  ('f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', '2026-08-16', 2, 1, 0, 1, 'open', '{"pms": {"status": "fresh"}}'),
  ('f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000002', '2026-08-15', 1, 0, 0, 1, 'open', '{"pms": {"status": "fresh"}}');

INSERT INTO pms.room_blocks
  (id, property_id, room_type_id, room_id, starts_on, ends_on, blocked_count, reason, status, created_by_user_id, created_at, released_at)
VALUES
  ('f6855400-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', 'f6855100-0000-0000-0000-000000000002', '2026-08-15', '2026-08-15', 1, 'Maintenance inspection', 'active', 'f6851000-0000-0000-0000-000000000001', '2026-08-01T09:00:00Z', NULL),
  ('f6855400-0000-0000-0000-000000000002', 'f6853000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000002', NULL, '2026-08-20', '2026-08-21', 1, 'Soft refurbishment', 'released', 'f6851000-0000-0000-0000-000000000001', '2026-08-01T10:00:00Z', '2026-08-05T10:00:00Z');

INSERT INTO pms.operational_booking_assignments
  (id, property_id, guest_booking_id, room_type_id, rate_plan_id, room_id, position, assignment_status, pms_reservation_ref, external_reservation_id, channel, source, assignment_payload, assigned_at)
VALUES
  ('f6855500-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6854000-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', 'f6855200-0000-0000-0000-000000000001', 'f6855100-0000-0000-0000-000000000001', 1, 'checked_out', 'PMS-685-301', 'chnx-booking-685', 'booking_com', 'channel', '{"channelRoomIndex": 0}', '2026-08-14T15:00:00Z');

INSERT INTO pms.checkin_checklist_templates
  (property_id, steps, updated_by_user_id, updated_at)
VALUES
  ('f6853000-0000-0000-0000-000000000001', '[{"key": "id_document", "label": "Verify ID"}, {"key": "deposit", "label": "Confirm deposit"}]', 'f6851000-0000-0000-0000-000000000001', '2026-08-01T08:00:00Z');

INSERT INTO pms.checkout_inspection_templates
  (property_id, steps, updated_by_user_id, updated_at)
VALUES
  ('f6853000-0000-0000-0000-000000000001', '[{"key": "minibar", "label": "Check minibar"}, {"key": "keys", "label": "Collect keys"}]', 'f6851000-0000-0000-0000-000000000001', '2026-08-01T08:05:00Z');

INSERT INTO pms.booking_checkin_records
  (id, property_id, guest_booking_id, assignment_id, completed_by_user_id, completed_at, step_results, pending_flags)
VALUES
  ('f6855600-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6854000-0000-0000-0000-000000000001', 'f6855500-0000-0000-0000-000000000001', 'f6851000-0000-0000-0000-000000000001', '2026-08-15T15:35:00Z', '[{"key": "id_document", "status": "done"}, {"key": "deposit", "status": "done"}]', '[]');

INSERT INTO pms.booking_checkout_charges
  (id, property_id, guest_booking_id, assignment_id, label, amount, original_amount, currency, status, created_by_user_id, created_at, settled_at)
VALUES
  ('f6855700-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6854000-0000-0000-0000-000000000001', 'f6855500-0000-0000-0000-000000000001', 'Minibar damage review', 35.00, 35.00, 'EUR', 'paid', 'f6851000-0000-0000-0000-000000000001', '2026-08-18T09:30:00Z', '2026-08-18T10:00:00Z');

INSERT INTO pms.booking_checkout_records
  (id, property_id, guest_booking_id, assignment_id, completed_by_user_id, completed_at, inspection_results, charges_settled, pending_flags, checkout_notes)
VALUES
  ('f6855800-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6854000-0000-0000-0000-000000000001', 'f6855500-0000-0000-0000-000000000001', 'f6851000-0000-0000-0000-000000000001', '2026-08-18T10:15:00Z', '[{"key": "minibar", "status": "charge_added"}, {"key": "keys", "status": "done"}]', '[{"chargeId": "f6855700-0000-0000-0000-000000000001", "status": "paid"}]', '[]', 'Internal checkout review complete.');

INSERT INTO pms.booking_notes_private
  (id, property_id, guest_booking_id, author_user_id, author_display_name, body, source, created_at)
VALUES
  ('f6855900-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6854000-0000-0000-0000-000000000001', 'f6851000-0000-0000-0000-000000000001', 'Operations Owner', 'VIP late checkout approved internally', 'pms', '2026-08-17T18:00:00Z');

INSERT INTO pms.message_threads
  (id, property_id, guest_booking_id, source, source_thread_id, source_booking_id, channel, guest_display_name, guest_email, status, last_message_at, last_message_preview, last_message_direction, unread_count)
VALUES
  ('f6856000-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6854000-0000-0000-0000-000000000001', 'channex', 'thread-685', 'chnx-booking-685', 'booking_com', 'Nora Ops', 'nora.ops@example.test', 'open', '2026-08-15T13:05:00Z', 'Passport scan received', 'inbound', 1);

INSERT INTO pms.messages
  (id, property_id, thread_id, source_message_id, direction, sender_type, sender_user_id, sender_display_name, body, sent_at, received_at, read_at, raw_payload, pii_retention_until)
VALUES
  ('f6856100-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6856000-0000-0000-0000-000000000001', 'msg-guest-685', 'inbound', 'guest', NULL, 'Nora Ops', 'Passport scan received', '2026-08-15T13:00:00Z', '2026-08-15T13:01:00Z', NULL, '{"provider": "channex"}', '2027-08-18'),
  ('f6856100-0000-0000-0000-000000000002', 'f6853000-0000-0000-0000-000000000001', 'f6856000-0000-0000-0000-000000000001', 'msg-property-685', 'outbound', 'property_user', 'f6851000-0000-0000-0000-000000000001', 'Operations Owner', 'Thank you, we have everything for check-in.', '2026-08-15T13:05:00Z', '2026-08-15T13:05:30Z', '2026-08-15T13:06:00Z', '{"provider": "channex"}', '2027-08-18');

INSERT INTO pms.message_attachments
  (id, property_id, message_id, s3_key, filename, content_type, size_bytes, source_attachment_id)
VALUES
  ('f6856200-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6856100-0000-0000-0000-000000000001', 'fixtures/pms-operations/passport-scan-redacted.pdf', 'passport-scan-redacted.pdf', 'application/pdf', 120432, 'att-685');

INSERT INTO pms.channel_connections
  (id, property_id, provider, connection_status, external_property_id, capabilities, messaging_app_installed, last_booking_sync_at, last_ari_sync_at, last_message_sync_at, connection_metadata)
VALUES
  ('f6856300-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'channex', 'connected', 'chnx-property-685', ARRAY['booking', 'ari', 'messaging'], TRUE, '2026-08-18T11:00:00Z', '2026-08-18T10:45:00Z', '2026-08-15T13:10:00Z', '{"fixture": "pms-operations"}');

INSERT INTO pms.channel_room_type_mappings
  (id, property_id, connection_id, room_type_id, external_room_type_id, status, mapping_metadata)
VALUES
  ('f6856400-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6856300-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', 'chnx-room-suite-685', 'active', '{"source": "channex"}'),
  ('f6856400-0000-0000-0000-000000000002', 'f6853000-0000-0000-0000-000000000001', 'f6856300-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000002', 'chnx-room-double-685', 'active', '{"source": "channex"}');

INSERT INTO pms.channel_rate_plan_mappings
  (id, property_id, connection_id, room_type_id, rate_plan_id, channel, external_room_type_id, external_rate_plan_id, sell_mode, markup_percent, status, mapping_metadata)
VALUES
  ('f6856500-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6856300-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000001', 'f6855200-0000-0000-0000-000000000001', 'booking_com', 'chnx-room-suite-685', 'chnx-rate-flex-685', 'per_room', 7.5000, 'active', '{"source": "channex"}'),
  ('f6856500-0000-0000-0000-000000000002', 'f6853000-0000-0000-0000-000000000001', 'f6856300-0000-0000-0000-000000000001', 'f6855000-0000-0000-0000-000000000002', 'f6855200-0000-0000-0000-000000000002', 'booking_com', 'chnx-room-double-685', 'chnx-rate-nrf-685', 'per_room', 5.0000, 'active', '{"source": "channex"}');

INSERT INTO pms.channel_booking_mappings
  (id, property_id, connection_id, guest_booking_id, assignment_id, external_booking_id, external_revision_id, channel, channel_room_index, sync_status, last_synced_at, mapping_metadata)
VALUES
  ('f6856600-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6856300-0000-0000-0000-000000000001', 'f6854000-0000-0000-0000-000000000001', 'f6855500-0000-0000-0000-000000000001', 'chnx-booking-685', 'rev-2', 'booking_com', 0, 'active', '2026-08-18T11:00:00Z', '{"roomTypeMappingId": "f6856400-0000-0000-0000-000000000001"}');

INSERT INTO pms.channel_sync_status
  (id, property_id, connection_id, sync_domain, status, last_attempt_at, last_success_at, sync_payload)
VALUES
  ('f6856700-0000-0000-0000-000000000001', 'f6853000-0000-0000-0000-000000000001', 'f6856300-0000-0000-0000-000000000001', 'booking', 'ok', '2026-08-18T11:00:00Z', '2026-08-18T11:00:00Z', '{"fixture": "pms-operations"}'),
  ('f6856700-0000-0000-0000-000000000002', 'f6853000-0000-0000-0000-000000000001', 'f6856300-0000-0000-0000-000000000001', 'ari', 'ok', '2026-08-18T10:45:00Z', '2026-08-18T10:45:00Z', '{"fixture": "pms-operations"}'),
  ('f6856700-0000-0000-0000-000000000003', 'f6853000-0000-0000-0000-000000000001', 'f6856300-0000-0000-0000-000000000001', 'message', 'ok', '2026-08-15T13:10:00Z', '2026-08-15T13:10:00Z', '{"fixture": "pms-operations"}');
