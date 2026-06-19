-- Migration: 0019_seed_ask_intelligence_role_grants
-- Owner: domain-identity (backend-authorization), domain-intelligence
-- See: engineering/ask-intelligence-architecture.md,
--      engineering/workos-identity-architecture.md
--
-- Grants the first owner-facing Ask Intelligence read path to hotel-group owner
-- role aliases. The Ask route still requires an active booking-engine
-- entitlement and a linked booking_hotel owner/operator resource; these grants
-- only supply the entry permission and the read-only booking/setup evidence
-- tool permissions.

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('hotel_group', 'hotel_owner', 'intelligence.ask.read'),
  ('hotel_group', 'hotel_owner', 'booking.analytics.read'),
  ('hotel_group', 'hotel_owner', 'booking.settings.read'),
  ('hotel_group', 'owner',       'intelligence.ask.read'),
  ('hotel_group', 'owner',       'booking.analytics.read'),
  ('hotel_group', 'owner',       'booking.settings.read'),
  ('hotel_group', 'operator',    'intelligence.ask.read'),
  ('hotel_group', 'operator',    'booking.analytics.read'),
  ('hotel_group', 'operator',    'booking.settings.read')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
