-- Migration: 0024_canonical_property_resource_links
-- Owner: domain-identity (backend-auth, backend-authorization), domain-hotels
-- See: engineering/shared-hotel-setup-status-contract.md, VAY-975
--
-- Enables direct canonical property ownership links:
--   product = 'hotel_catalog'
--   resource_type = 'property'
--   resource_id = hotel_catalog.properties.id
--
-- property_source_links remains source/product provenance. It is used here only
-- to backfill direct identity links from existing product ownership rows.

ALTER TABLE identity.organization_resource_links
  DROP CONSTRAINT IF EXISTS organization_resource_links_product_check;
ALTER TABLE identity.organization_resource_links
  DROP CONSTRAINT IF EXISTS chk_organization_resource_links_product;
ALTER TABLE identity.organization_resource_links
  ADD CONSTRAINT chk_organization_resource_links_product
  CHECK (product IN ('platform', 'hotel_catalog', 'marketplace', 'booking', 'pms', 'affiliate'));

ALTER TABLE identity.organization_resource_links
  DROP CONSTRAINT IF EXISTS organization_resource_links_resource_type_check;
ALTER TABLE identity.organization_resource_links
  DROP CONSTRAINT IF EXISTS chk_organization_resource_links_resource_type;
ALTER TABLE identity.organization_resource_links
  ADD CONSTRAINT chk_organization_resource_links_resource_type
  CHECK (resource_type IN (
    'platform',
    'property',
    'booking_hotel',
    'pms_hotel',
    'pms_property',
    'hotel_profile',
    'hotel_listing',
    'creator_profile',
    'affiliate',
    'payout_account'
  ));

ALTER TABLE identity.product_entitlements
  DROP CONSTRAINT IF EXISTS product_entitlements_product_check;
ALTER TABLE identity.product_entitlements
  DROP CONSTRAINT IF EXISTS chk_product_entitlements_product;
ALTER TABLE identity.product_entitlements
  ADD CONSTRAINT chk_product_entitlements_product
  CHECK (product IN ('platform', 'hotel_catalog', 'marketplace', 'booking', 'pms', 'affiliate'));

ALTER TABLE identity.product_entitlements
  DROP CONSTRAINT IF EXISTS product_entitlements_resource_product_check;
ALTER TABLE identity.product_entitlements
  DROP CONSTRAINT IF EXISTS chk_product_entitlements_resource_product;
ALTER TABLE identity.product_entitlements
  ADD CONSTRAINT chk_product_entitlements_resource_product
  CHECK (
    resource_product IS NULL
    OR resource_product IN ('platform', 'hotel_catalog', 'marketplace', 'booking', 'pms', 'affiliate')
  );

ALTER TABLE identity.product_entitlements
  DROP CONSTRAINT IF EXISTS product_entitlements_resource_type_check;
ALTER TABLE identity.product_entitlements
  DROP CONSTRAINT IF EXISTS chk_product_entitlements_resource_type;
ALTER TABLE identity.product_entitlements
  ADD CONSTRAINT chk_product_entitlements_resource_type
  CHECK (
    resource_type IS NULL
    OR resource_type IN (
      'platform',
      'property',
      'booking_hotel',
      'pms_hotel',
      'pms_property',
      'hotel_profile',
      'hotel_listing',
      'creator_profile',
      'affiliate',
      'payout_account'
    )
  );

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('hotel_catalog.setup.read', 'hotel_catalog', 'Read shared hotel setup status for canonical properties')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('hotel_group', 'hotel_owner', 'hotel_catalog.setup.read'),
  ('hotel_group', 'owner',       'hotel_catalog.setup.read'),
  ('hotel_group', 'operator',    'hotel_catalog.setup.read')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;

WITH property_link_candidates AS (
  SELECT
    link.organization_id,
    source.property_id,
    link.relationship
  FROM identity.organization_resource_links link
  JOIN identity.organizations organization
    ON organization.id = link.organization_id
  JOIN hotel_catalog.property_source_links source
    ON source.source_system = 'booking'
   AND source.source_table = 'booking_hotels'
   AND source.source_id = link.resource_id
   AND source.status = 'active'
  WHERE organization.kind = 'hotel_group'
    AND organization.status = 'active'
    AND link.status = 'active'
    AND link.product = 'booking'
    AND link.resource_type = 'booking_hotel'
    AND link.relationship IN ('owner', 'operator')

  UNION ALL

  SELECT
    link.organization_id,
    source.property_id,
    link.relationship
  FROM identity.organization_resource_links link
  JOIN identity.organizations organization
    ON organization.id = link.organization_id
  JOIN hotel_catalog.property_source_links source
    ON source.source_system = 'pms'
   AND source.source_table = 'hotels'
   AND source.source_id = link.resource_id
   AND source.status = 'active'
  WHERE organization.kind = 'hotel_group'
    AND organization.status = 'active'
    AND link.status = 'active'
    AND link.product = 'pms'
    AND link.resource_type = 'pms_hotel'
    AND link.relationship IN ('owner', 'operator')

  UNION ALL

  SELECT
    link.organization_id,
    property.id AS property_id,
    link.relationship
  FROM identity.organization_resource_links link
  JOIN identity.organizations organization
    ON organization.id = link.organization_id
  JOIN hotel_catalog.properties property
    ON property.id::text = link.resource_id
  WHERE organization.kind = 'hotel_group'
    AND organization.status = 'active'
    AND link.status = 'active'
    AND link.product = 'pms'
    AND link.resource_type = 'pms_property'
    AND link.relationship IN ('owner', 'operator')

  UNION ALL

  SELECT
    link.organization_id,
    profile.property_id,
    link.relationship
  FROM identity.organization_resource_links link
  JOIN identity.organizations organization
    ON organization.id = link.organization_id
  JOIN marketplace.marketplace_hotel_profiles profile
    ON profile.organization_id = link.organization_id
   AND (
     profile.property_id::text = link.resource_id
     OR profile.source_hotel_profile_id = link.resource_id
   )
  WHERE organization.kind = 'hotel_group'
    AND organization.status = 'active'
    AND link.status = 'active'
    AND link.product = 'marketplace'
    AND link.resource_type = 'hotel_profile'
    AND link.relationship IN ('owner', 'operator')

  UNION ALL

  SELECT
    link.organization_id,
    listing.property_id,
    link.relationship
  FROM identity.organization_resource_links link
  JOIN identity.organizations organization
    ON organization.id = link.organization_id
  JOIN marketplace.marketplace_hotel_listings listing
    ON listing.organization_id = link.organization_id
   AND (
     listing.id::text = link.resource_id
     OR listing.source_listing_id = link.resource_id
   )
  WHERE organization.kind = 'hotel_group'
    AND organization.status = 'active'
    AND link.status = 'active'
    AND link.product = 'marketplace'
    AND link.resource_type = 'hotel_listing'
    AND link.relationship IN ('owner', 'operator')
),
canonical_property_links AS (
  SELECT
    organization_id,
    property_id::text AS resource_id,
    CASE WHEN bool_or(relationship = 'owner') THEN 'owner' ELSE 'operator' END AS relationship
  FROM property_link_candidates
  GROUP BY organization_id, property_id
)
INSERT INTO identity.organization_resource_links
  (organization_id, product, resource_type, resource_id, relationship, status)
SELECT
  organization_id,
  'hotel_catalog',
  'property',
  resource_id,
  relationship,
  'active'
FROM canonical_property_links
ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
DO UPDATE SET status = 'active', updated_at = now();
