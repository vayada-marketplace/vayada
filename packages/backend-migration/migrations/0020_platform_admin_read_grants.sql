-- Migration: 0020_platform_admin_read_grants
-- Owner: domain-identity (backend-authorization)
-- See: engineering/request-context-contract.md, engineering/workos-identity-architecture.md
--
-- Grants platform admins the read permission enforced by the TypeScript
-- platform admin dashboard compatibility routes.

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('platform.admin.read', 'platform', 'Read platform admin dashboard data')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('platform', 'platform_admin', 'platform.admin.read')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
