-- Migration: 0025_property_product_selections
-- Owner: domain-hotels
-- See: VAY-968, engineering/shared-hotel-setup-status-contract.md
--
-- Stores hotel-group intent to activate Booking, PMS, and Marketplace per
-- canonical property. Identity resource links authorize property access, and
-- product_entitlements represent access/billing state; neither cleanly records
-- "this hotel selected this product for this property".

CREATE TABLE hotel_catalog.property_product_selections (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  property_id     UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  product         TEXT        NOT NULL CHECK (product IN ('booking', 'pms', 'marketplace')),
  status          TEXT        NOT NULL DEFAULT 'selected' CHECK (status IN ('selected', 'unselected')),
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_property_product_selections_property_product
    UNIQUE (organization_id, property_id, product)
);

CREATE INDEX idx_property_product_selections_property_status
  ON hotel_catalog.property_product_selections (organization_id, property_id, status);

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('hotel_catalog.setup.manage', 'hotel_catalog', 'Select products for shared hotel setup on canonical properties')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('hotel_group', 'hotel_owner', 'hotel_catalog.setup.manage'),
  ('hotel_group', 'owner',       'hotel_catalog.setup.manage'),
  ('hotel_group', 'operator',    'hotel_catalog.setup.manage')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
