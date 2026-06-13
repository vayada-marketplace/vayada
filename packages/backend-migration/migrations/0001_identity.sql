-- Migration: 0001_identity
-- Owner: domain-identity (backend-auth, backend-authorization)
-- See: engineering/target-schema-ownership-map.md, engineering/workos-identity-architecture.md
--
-- Creates the identity schema with all tables needed for internal users,
-- provider identity mapping, organizations, memberships, permissions,
-- resource links, and auth reconciliation events.
--
-- Legacy fields that are NOT present here (they are migration transform inputs only):
--   users.type, users.is_superadmin, product user_id ownership columns.

CREATE SCHEMA IF NOT EXISTS identity;

-- Internal users — stable Vayada principal IDs.
-- users.id is preserved across the migration from auth-db.users.id.
CREATE TABLE identity.users (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT         NOT NULL,
  name        TEXT,
  status      TEXT         NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'pending', 'suspended', 'deleted')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Provider identity mappings — maps WorkOS (or future provider) IDs to internal users.
-- Email is a bootstrap/recovery signal only, not the authorization key.
-- A partial unique index enforces uniqueness for known provider_user_ids while
-- allowing multiple unlinked rows with provider_user_id IS NULL.
CREATE TABLE identity.external_identities (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID         NOT NULL REFERENCES identity.users(id),
  provider                TEXT         NOT NULL CHECK (provider IN ('workos')),
  provider_user_id        TEXT,
  provider_email          TEXT,
  provider_email_verified BOOLEAN      NOT NULL DEFAULT FALSE,
  last_login_at           TIMESTAMPTZ,
  raw_profile             JSONB,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_external_identities_provider_user_id
  ON identity.external_identities (provider, provider_user_id)
  WHERE provider_user_id IS NOT NULL;

-- Internal organizations — Vayada tenant containers.
-- workos_org_id and workos_external_id are nullable during backfill;
-- once a tenant is WorkOS-managed they must be populated.
CREATE TABLE identity.organizations (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               TEXT         NOT NULL
                       CHECK (kind IN ('platform', 'hotel_group', 'creator_workspace', 'affiliate_partner')),
  name               TEXT         NOT NULL,
  slug               TEXT         NOT NULL,
  status             TEXT         NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'archived')),
  workos_org_id      TEXT         UNIQUE,
  workos_external_id TEXT         UNIQUE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Organization memberships — links users to organizations with a product role.
-- One membership per user per organization; workos_membership_id is unique where present.
CREATE TABLE identity.organization_memberships (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID         NOT NULL REFERENCES identity.organizations(id),
  user_id              UUID         NOT NULL REFERENCES identity.users(id),
  status               TEXT         NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'pending', 'inactive', 'suspended')),
  role_key             TEXT         NOT NULL,
  permission_overrides JSONB,
  workos_membership_id TEXT         UNIQUE,
  workos_role_slugs    TEXT[]       NOT NULL DEFAULT '{}',
  invited_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_organization_memberships_org_user
    UNIQUE (organization_id, user_id)
);

-- Permission catalog — stable permission keys used by the authorization layer.
-- Seeded from the PermissionKey union in apps/api/src/platform/requestContext.ts.
CREATE TABLE identity.permission_catalog (
  key         TEXT         PRIMARY KEY,
  description TEXT,
  product     TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Role permission grants — which permissions a role key holds within an org kind.
CREATE TABLE identity.role_permission_grants (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_kind TEXT        NOT NULL
                      CHECK (organization_kind IN ('platform', 'hotel_group', 'creator_workspace', 'affiliate_partner')),
  role_key          TEXT        NOT NULL,
  permission_key    TEXT        NOT NULL REFERENCES identity.permission_catalog(key),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_role_permission_grants UNIQUE (organization_kind, role_key, permission_key)
);

-- Organization resource links — maps organizations to product resources.
-- Replaces direct user_id ownership on booking/PMS/marketplace/affiliate records.
CREATE TABLE identity.organization_resource_links (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES identity.organizations(id),
  product         TEXT        NOT NULL
                    CHECK (product IN ('platform', 'marketplace', 'booking', 'pms', 'affiliate')),
  resource_type   TEXT        NOT NULL
                    CHECK (resource_type IN (
                      'platform', 'booking_hotel', 'pms_hotel', 'pms_property', 'hotel_profile',
                      'hotel_listing', 'creator_profile', 'affiliate', 'payout_account'
                    )),
  resource_id     TEXT        NOT NULL,
  relationship    TEXT        NOT NULL
                    CHECK (relationship IN (
                      'owner', 'operator', 'front_desk', 'promotes', 'billing_account'
                    )),
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'archived')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_organization_resource_links
    UNIQUE (organization_id, product, resource_type, resource_id, relationship)
);

-- Auth reconciliation events — provider webhook and migration linking events.
-- Not product audit; product audit lives in platform.product_audit_events (future).
CREATE TABLE identity.auth_reconciliation_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        TEXT        NOT NULL,
  provider          TEXT        NOT NULL CHECK (provider IN ('workos')),
  provider_event_id TEXT,
  user_id           UUID        REFERENCES identity.users(id),
  organization_id   UUID        REFERENCES identity.organizations(id),
  payload           JSONB,
  processed_at      TIMESTAMPTZ,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the permission catalog to match the PermissionKey union in
-- apps/api/src/platform/requestContext.ts. ON CONFLICT DO NOTHING makes
-- this idempotent if the migration is re-applied during local rebuilds.
INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('platform.user.suspend',            'platform',    'Suspend or reinstate a Vayada user account'),
  ('booking.settings.manage',          'booking',     'Manage booking engine settings for a hotel'),
  ('booking.reservation.read',         'booking',     'Read booking reservations for a hotel'),
  ('pms.operations.read',              'pms',         'Read PMS operational rooms, room types, inventory, and reservations for a property'),
  ('pms.operations.manage',            'pms',         'Manage PMS operational rooms, room types, inventory, assignments, and reservation actions for a property'),
  ('pms.booking.update',               'pms',         'Update PMS bookings for a hotel'),
  ('pms.finance.read',                 'pms',         'Read financial data in the PMS for a hotel'),
  ('marketplace.collaboration.read',   'marketplace', 'Read marketplace collaborations and chat for linked creator or hotel resources'),
  ('marketplace.collaboration.write',  'marketplace', 'Create and update marketplace collaborations and chat for linked creator or hotel resources'),
  ('marketplace.collaboration.review', 'marketplace', 'Review and manage marketplace collaborations'),
  ('marketplace.profile.manage',       'marketplace', 'Manage a marketplace hotel or creator profile'),
  ('affiliate.payout.manage',          'affiliate',   'Manage affiliate payout settings and runs')
ON CONFLICT (key) DO NOTHING;
