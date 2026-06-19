-- Migration: 0002_initial_role_grants
-- Owner: domain-identity (backend-authorization)
-- See: engineering/request-context-contract.md, engineering/workos-identity-architecture.md
--
-- Seeds the initial role grants used by RequestContext authorization tests.
-- Fine-grained role design will expand in follow-up tickets; this baseline
-- keeps the auth boundary executable for the initial hotel/creator/affiliate/platform scopes.

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('platform',          'platform_admin', 'platform.user.suspend'),
  ('hotel_group',       'hotel_owner',    'booking.settings.manage'),
  ('hotel_group',       'hotel_owner',    'booking.reservation.read'),
  ('hotel_group',       'hotel_owner',    'pms.operations.read'),
  ('hotel_group',       'hotel_owner',    'pms.operations.manage'),
  ('hotel_group',       'hotel_owner',    'pms.booking.update'),
  ('hotel_group',       'hotel_owner',    'pms.finance.read'),
  ('hotel_group',       'hotel_owner',    'marketplace.collaboration.read'),
  ('hotel_group',       'hotel_owner',    'marketplace.collaboration.write'),
  ('hotel_group',       'hotel_owner',    'marketplace.collaboration.review'),
  ('hotel_group',       'owner',          'booking.settings.manage'),
  ('hotel_group',       'owner',          'booking.reservation.read'),
  ('hotel_group',       'owner',          'pms.operations.read'),
  ('hotel_group',       'owner',          'pms.operations.manage'),
  ('hotel_group',       'owner',          'pms.booking.update'),
  ('hotel_group',       'owner',          'pms.finance.read'),
  ('hotel_group',       'owner',          'marketplace.collaboration.read'),
  ('hotel_group',       'owner',          'marketplace.collaboration.write'),
  ('hotel_group',       'owner',          'marketplace.collaboration.review'),
  ('creator_workspace', 'creator_owner',  'marketplace.collaboration.read'),
  ('creator_workspace', 'creator_owner',  'marketplace.collaboration.write'),
  ('creator_workspace', 'creator_owner',  'marketplace.profile.manage'),
  ('affiliate_partner', 'affiliate_owner', 'affiliate.payout.manage')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
