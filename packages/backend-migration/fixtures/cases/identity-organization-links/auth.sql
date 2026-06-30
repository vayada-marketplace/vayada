-- Fixture: identity-organization-links / auth.sql
--
-- Represents source-side auth and legacy ownership inputs for one hotel owner.
-- The rebuild command loads these rows into a migration-only fixture schema,
-- then packages/backend-migration transforms them into identity target tables.

DROP SCHEMA IF EXISTS migration_source_auth CASCADE;
CREATE SCHEMA migration_source_auth;

CREATE TABLE migration_source_auth.users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  workos_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE migration_source_auth.identity_organization_links (
  source_row_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  organization_kind TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  organization_slug TEXT NOT NULL,
  organization_status TEXT NOT NULL DEFAULT 'active',
  workos_org_id TEXT,
  workos_external_id TEXT,
  membership_status TEXT NOT NULL DEFAULT 'active',
  role_key TEXT NOT NULL,
  workos_membership_id TEXT,
  workos_role_slugs TEXT[] NOT NULL DEFAULT '{}',
  product TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  resource_status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE migration_source_auth.identity_entitlement_inputs (
  source_row_id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL,
  product TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  resource_product TEXT,
  resource_type TEXT,
  resource_id TEXT,
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

INSERT INTO migration_source_auth.users
  (id, email, name, type, status, email_verified, workos_user_id, created_at, updated_at)
VALUES
  (
    'a1b2c3d4-0000-0000-0000-000000000001',
    'owner@example.com',
    'Hotel Owner',
    'hotel',
    'verified',
    TRUE,
    'user_workos_hotel_owner',
    '2026-01-01T00:00:00Z',
    '2026-01-02T00:00:00Z'
  );

INSERT INTO migration_source_auth.identity_organization_links
  (
    source_row_id,
    user_id,
    organization_id,
    organization_kind,
    organization_name,
    organization_slug,
    organization_status,
    workos_org_id,
    workos_external_id,
    membership_status,
    role_key,
    workos_membership_id,
    workos_role_slugs,
    product,
    resource_type,
    resource_id,
    relationship,
    resource_status,
    created_at,
    updated_at
  )
VALUES
  (
    'booking-hotel-owner',
    'a1b2c3d4-0000-0000-0000-000000000001',
    'b2c3d4e5-0000-0000-0000-000000000001',
    'hotel_group',
    'Hotel Alpenrose Group',
    'hotel-alpenrose-group',
    'active',
    'org_workos_hotel_group',
    'b2c3d4e5-0000-0000-0000-000000000001',
    'active',
    'hotel_owner',
    'om_hotel_owner',
    ARRAY['hotel_owner'],
    'booking',
    'booking_hotel',
    'booking_hotel_alpenrose',
    'owner',
    'active',
    '2026-01-01T00:00:00Z',
    '2026-01-02T00:00:00Z'
  ),
  (
    'pms-hotel-operator',
    'a1b2c3d4-0000-0000-0000-000000000001',
    'b2c3d4e5-0000-0000-0000-000000000001',
    'hotel_group',
    'Hotel Alpenrose Group',
    'hotel-alpenrose-group',
    'active',
    'org_workos_hotel_group',
    'b2c3d4e5-0000-0000-0000-000000000001',
    'active',
    'hotel_owner',
    'om_hotel_owner',
    ARRAY['hotel_owner'],
    'pms',
    'pms_hotel',
    'pms_hotel_alpenrose',
    'operator',
    'active',
    '2026-01-01T00:00:00Z',
    '2026-01-02T00:00:00Z'
  ),
  (
    'canonical-property-owner',
    'a1b2c3d4-0000-0000-0000-000000000001',
    'b2c3d4e5-0000-0000-0000-000000000001',
    'hotel_group',
    'Hotel Alpenrose Group',
    'hotel-alpenrose-group',
    'active',
    'org_workos_hotel_group',
    'b2c3d4e5-0000-0000-0000-000000000001',
    'active',
    'hotel_owner',
    'om_hotel_owner',
    ARRAY['hotel_owner'],
    'hotel_catalog',
    'property',
    'c2c3d4e5-0000-0000-0000-000000000001',
    'owner',
    'active',
    '2026-01-01T00:00:00Z',
    '2026-01-02T00:00:00Z'
  );

INSERT INTO migration_source_auth.identity_entitlement_inputs
  (
    source_row_id,
    organization_id,
    product,
    entitlement_key,
    status,
    resource_product,
    resource_type,
    resource_id,
    metadata,
    created_at,
    updated_at
  )
VALUES
  (
    'booking-engine-org-entitlement',
    'b2c3d4e5-0000-0000-0000-000000000001',
    'booking',
    'booking-engine',
    'active',
    NULL,
    NULL,
    NULL,
    '{"source":"booking_hotels.platform_status"}'::jsonb,
    '2026-01-01T00:00:00Z',
    '2026-01-02T00:00:00Z'
  ),
  (
    'pms-core-resource-entitlement',
    'b2c3d4e5-0000-0000-0000-000000000001',
    'pms',
    'pms-core',
    'active',
    'pms',
    'pms_hotel',
    'pms_hotel_alpenrose',
    '{"source":"property_module_activations"}'::jsonb,
    '2026-01-01T00:00:00Z',
    '2026-01-02T00:00:00Z'
  );
