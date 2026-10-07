-- VAY-965: product owner links belong only to this transaction's new property.
-- Lock current authority before checking time windows; no runtime grants here.
CREATE FUNCTION platform.hotel_setup_creation_product_link_allowed(
  requested_organization UUID, requested_product TEXT, requested_resource_type TEXT,
  requested_resource_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE assigned_organization UUID; requested_property UUID; checked_at TIMESTAMPTZ;
DECLARE selected_tracks TEXT[]; required_products TEXT[];
BEGIN
  assigned_organization := platform.hotel_setup_creation_assigned_organization();
  IF assigned_organization IS NULL OR assigned_organization <> requested_organization
    OR NOT pg_catalog.pg_input_is_valid(requested_resource_id, 'uuid')
    OR (requested_product, requested_resource_type) NOT IN
      (('booking', 'booking_hotel'), ('pms', 'pms_property'), ('marketplace', 'hotel_profile'))
  THEN RETURN FALSE; END IF;
  requested_property := requested_resource_id::uuid;
  IF NOT platform.hotel_setup_new_property_allowed(requested_property) THEN RETURN FALSE; END IF;
  PERFORM 1 FROM identity.organization_resource_links link
  WHERE link.organization_id = assigned_organization AND link.product = 'hotel_catalog'
    AND link.resource_type = 'property' AND link.relationship = 'owner' AND link.status = 'active'
    AND platform.hotel_setup_property_link_matches(requested_property, link.resource_id)
  FOR SHARE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM identity.organization_resource_links link
    WHERE link.product = requested_product AND link.resource_type = requested_resource_type
      AND link.relationship = 'owner'
      AND platform.hotel_setup_property_link_matches(requested_property, link.resource_id)
      AND (link.organization_id <> assigned_organization OR link.status <> 'active'))
  THEN RETURN FALSE; END IF;
  SELECT intent.selected_tracks INTO selected_tracks
  FROM hotel_catalog.organization_setup_track_intents intent
  WHERE intent.organization_id = assigned_organization FOR SHARE;
  IF requested_product = 'marketplace' THEN
    IF NOT COALESCE('creator_marketplace' = ANY(selected_tracks), FALSE) THEN RETURN FALSE; END IF;
    required_products := ARRAY['marketplace'];
  ELSE
    IF NOT COALESCE('hotel_operations' = ANY(selected_tracks), FALSE) THEN RETURN FALSE; END IF;
    required_products := ARRAY['booking', 'pms'];
  END IF;
  -- Include legacy aliases in revocation checks, even when the caller reads canonical keys.
  PERFORM 1 FROM identity.product_entitlements entitlement
  WHERE entitlement.organization_id = assigned_organization
    AND entitlement.product = ANY(required_products)
    AND entitlement.entitlement_key IN ('booking-engine', 'property-management',
      'marketplace-hotel-profile', 'account_access', 'pms-core')
    AND entitlement.resource_product IS NULL FOR SHARE;
  PERFORM 1 FROM finance.billing_entitlements billing
  WHERE billing.organization_id = assigned_organization AND billing.product = ANY(required_products)
    AND billing.entitlement_key IN ('booking-engine', 'property-management',
      'marketplace-hotel-profile', 'account_access', 'pms-core')
    AND billing.property_id IS NULL FOR SHARE;
  checked_at := pg_catalog.clock_timestamp();
  RETURN NOT EXISTS (
    SELECT 1 FROM unnest(required_products) AS required(product)
    CROSS JOIN LATERAL (SELECT CASE required.product
      WHEN 'booking' THEN 'booking-engine' WHEN 'pms' THEN 'property-management'
      ELSE 'marketplace-hotel-profile' END AS canonical_key) key
    WHERE NOT EXISTS (
      SELECT 1 FROM identity.product_entitlements entitlement
      WHERE entitlement.organization_id = assigned_organization AND entitlement.product = required.product
        AND entitlement.entitlement_key IN (key.canonical_key, 'account_access',
          CASE WHEN required.product = 'pms' THEN 'pms-core' ELSE key.canonical_key END)
        AND entitlement.resource_product IS NULL AND entitlement.status = 'active'
        AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= checked_at)
        AND (entitlement.expires_at IS NULL OR entitlement.expires_at > checked_at)
    ) OR EXISTS (
      SELECT 1 FROM identity.product_entitlements entitlement
      WHERE entitlement.organization_id = assigned_organization AND entitlement.product = required.product
        AND entitlement.entitlement_key IN (key.canonical_key, 'account_access',
          CASE WHEN required.product = 'pms' THEN 'pms-core' ELSE key.canonical_key END)
        AND entitlement.resource_product IS NULL AND entitlement.status = 'suspended'
        AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= checked_at)
        AND (entitlement.expires_at IS NULL OR entitlement.expires_at > checked_at)
    ) OR EXISTS (
      SELECT 1 FROM finance.billing_entitlements billing
      WHERE billing.organization_id = assigned_organization AND billing.product = required.product
        AND billing.entitlement_key IN (key.canonical_key, 'account_access',
          CASE WHEN required.product = 'pms' THEN 'pms-core' ELSE key.canonical_key END)
        AND billing.property_id IS NULL
        AND (billing.starts_at IS NULL OR billing.starts_at <= checked_at)
        AND (billing.expires_at IS NULL OR billing.expires_at > checked_at)
        AND billing.billing_status IN ('past_due', 'suspended')
    ) OR (EXISTS (
      SELECT 1 FROM finance.billing_entitlements billing
      WHERE billing.organization_id = assigned_organization AND billing.product = required.product
        AND billing.entitlement_key IN (key.canonical_key, 'account_access',
          CASE WHEN required.product = 'pms' THEN 'pms-core' ELSE key.canonical_key END)
        AND billing.property_id IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM finance.billing_entitlements billing
      WHERE billing.organization_id = assigned_organization AND billing.product = required.product
        AND billing.entitlement_key IN (key.canonical_key, 'account_access',
          CASE WHEN required.product = 'pms' THEN 'pms-core' ELSE key.canonical_key END)
        AND billing.property_id IS NULL AND billing.billing_status IN ('trialing', 'active')
        AND (billing.starts_at IS NULL OR billing.starts_at <= checked_at)
        AND (billing.expires_at IS NULL OR billing.expires_at > checked_at)
    ))
  );
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_creation_product_link_allowed(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_creation_product_link_allowed(UUID, TEXT, TEXT, TEXT)
  TO vayada_next_hotel_setup_scope;

ALTER POLICY hotel_setup_owner_link_read_scope ON identity.organization_resource_links USING (
  (product, resource_type) IN (('hotel_catalog', 'property'), ('booking', 'booking_hotel'),
    ('pms', 'pms_property'), ('marketplace', 'hotel_profile'))
  AND relationship = 'owner' AND status = 'active'
  AND organization_id = platform.hotel_setup_creation_assigned_organization()
  AND EXISTS (SELECT 1 FROM hotel_catalog.properties property
    WHERE platform.hotel_setup_property_link_matches(property.id, organization_resource_links.resource_id)
      AND platform.hotel_setup_property_read_allowed(property.id, property.creation_organization_id))
);
ALTER POLICY hotel_setup_owner_link_insert_scope ON identity.organization_resource_links WITH CHECK (
  relationship = 'owner' AND status = 'active'
  AND ((product = 'hotel_catalog' AND resource_type = 'property'
      AND platform.hotel_setup_owner_link_insert_allowed(organization_id, resource_id))
    OR platform.hotel_setup_creation_product_link_allowed(organization_id, product, resource_type, resource_id))
);
