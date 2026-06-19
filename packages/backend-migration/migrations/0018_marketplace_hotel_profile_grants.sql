-- Migration: 0018_marketplace_hotel_profile_grants
-- Owner: marketplace
-- See: engineering/marketplace-hotel-self-service-contract.md
--
-- Enables hotel-group roles to access marketplace hotel profile self-service
-- routes guarded by marketplace.profile.manage.

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('hotel_group', 'hotel_owner', 'marketplace.profile.manage'),
  ('hotel_group', 'owner',       'marketplace.profile.manage')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
