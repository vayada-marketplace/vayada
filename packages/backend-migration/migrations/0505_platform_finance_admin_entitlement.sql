-- Migration: 0505_platform_finance_admin_entitlement
-- Owner: domain-finance / VAY-2205
-- See: apps/api/src/routes/financePlatformAuthorization.ts
--
-- The platform Finance routes (Vayada Admin's Payments tab, which turns card payments on per hotel)
-- need the platform organization's finance-admin entitlement on platform/platform/vayada. 0086 gave
-- it once, to the platform organizations that existed then. The Vayada Platform organization came
-- later, from the platform identity bootstrap (VAY-1334), which gave platform-admin only, so its
-- admins get 403 there. The bootstrap now gives both, for environments set up after this.
--
-- The same idempotent insert as 0086, for active platform organizations that operate Vayada: an
-- active operator or finance_manager link to platform/platform/vayada. A row of the same scope that
-- already exists, suspended or expired included, stays as it is.
--
-- Rollback: suspend the row (status 'suspended') in a reviewed migration; the routes answer 403
-- again.

SET LOCAL lock_timeout = '5s';

INSERT INTO identity.product_entitlements (
  organization_id, product, entitlement_key, status,
  resource_product, resource_type, resource_id, metadata
)
SELECT organization.id, 'platform', 'finance-admin', 'active',
       'platform', 'platform', 'vayada',
       '{"source":"0505_platform_finance_admin_entitlement"}'::jsonb
FROM identity.organizations organization
WHERE organization.kind = 'platform'
  AND organization.status = 'active'
  AND EXISTS (
    SELECT 1
    FROM identity.organization_resource_links link
    WHERE link.organization_id = organization.id
      AND link.product = 'platform'
      AND link.resource_type = 'platform'
      AND link.resource_id = 'vayada'
      AND link.relationship IN ('operator', 'finance_manager')
      AND link.status = 'active'
  )
ON CONFLICT DO NOTHING;
