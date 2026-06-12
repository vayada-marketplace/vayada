-- Migration: 0003_product_entitlements
-- Owner: domain-identity read model (backend-authorization)
-- See: engineering/request-context-contract.md, engineering/target-schema-ownership-map.md
--
-- Adds the entitlement read model consumed by RequestContext. This is not the
-- billing source of truth: finance/product domains own upstream entitlement
-- writes, and authenticated backend requests read the normalized state here.
--
-- Keep CHECK values aligned with backend-auth types:
-- Product: product, resource_product
-- EntitlementStatus: status
-- ResourceType: resource_type

CREATE TABLE identity.product_entitlements (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID        NOT NULL REFERENCES identity.organizations(id),
  product           TEXT        NOT NULL
                      CHECK (product IN ('platform', 'marketplace', 'booking', 'pms', 'affiliate')),
  entitlement_key   TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'expired')),
  resource_product  TEXT
                      CHECK (resource_product IS NULL OR resource_product IN ('platform', 'marketplace', 'booking', 'pms', 'affiliate')),
  resource_type     TEXT
                      CHECK (resource_type IS NULL OR resource_type IN (
                        'platform', 'booking_hotel', 'pms_hotel', 'pms_property', 'hotel_profile',
                        'hotel_listing', 'creator_profile', 'affiliate', 'payout_account'
                      )),
  resource_id       TEXT,
  starts_at         TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_product_entitlements_resource_scope
    CHECK (
      (resource_product IS NULL AND resource_type IS NULL AND resource_id IS NULL)
      OR
      (resource_product IS NOT NULL AND resource_type IS NOT NULL AND resource_id IS NOT NULL)
    ),
  CONSTRAINT chk_product_entitlements_date_order
    CHECK (
      starts_at IS NULL
      OR expires_at IS NULL
      OR starts_at <= expires_at
    )
);

CREATE UNIQUE INDEX uq_product_entitlements_scope
  ON identity.product_entitlements (
    organization_id,
    product,
    entitlement_key,
    COALESCE(resource_product, ''),
    COALESCE(resource_type, ''),
    COALESCE(resource_id, '')
  );

CREATE INDEX idx_product_entitlements_org_status
  ON identity.product_entitlements (organization_id, status);
