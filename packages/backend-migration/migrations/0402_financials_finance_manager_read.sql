-- VAY-1138: Financials read access for property finance managers.
-- The Financials route adapters also require property-management and
-- module:financials entitlements for the selected property.
-- Existing payment/settings Finance reads share this permission and retain
-- their property-management or direct-booking-finance entitlement and property-link
-- guards. Eligible managers gain those reads before Financials module activation.
INSERT INTO identity.role_permission_grants
  (organization_kind, role_key, permission_key)
VALUES ('hotel_group', 'finance_manager', 'pms.finance.read')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
