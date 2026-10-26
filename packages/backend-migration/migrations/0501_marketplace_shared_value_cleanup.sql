-- Migration: 0501_marketplace_shared_value_cleanup
-- Owner: platform / VAY-2272 (Marketplace removal step 5, M-F, window W4). HOLD: merge only with
-- Flamur's yes, after the counts-0501 before-runs.
--
-- Removes the Marketplace and affiliate values that nothing writes any more from the shared tables:
-- the retired login surfaces, the affiliate and Marketplace finance visibility scopes and keys, the 9
-- Marketplace and affiliate permission keys, the creator and affiliate kinds in role grants, and the
-- retired products, resource types and the promotes relationship in links and entitlements. Decision
-- 9: the marketplace_overlay page address goes too. Two keys that only dropped tables used go as
-- well: the (id, organization_id) keys of commission rules (Marketplace collaborations) and of payouts
-- (affiliate payment evidence).
-- 0498 deleted the affiliate program's commission rules and billing entitlements (Flamur's yes to
-- question 10), so their affiliate values go too: the affiliate scope and product, the affiliate_id
-- column and the two indexes for affiliate rules.
-- Kept: the organization kinds (0500 keeps closed creator and payee rows), media purposes (the purge
-- job still reads them), the creator contact purpose (decision 9), and the marketplace source and
-- product values of kept rows, commission rules and billing entitlements included.
-- 0499 drops the Marketplace matching-event payload check, since it locks platform.domain_events anyway.
-- Rollback: any image from the 0500 release on; none of them writes these values. The legacy finance
-- import and cutover need an image with this migration: older ones still name affiliate_id.

SET LOCAL lock_timeout = '5s';
-- Each lock waits at most 5 seconds, and the LOCK statement at most 15.
SET LOCAL statement_timeout = '15s';

-- Every table this changes, in one statement and one order.
LOCK TABLE
  finance.billing_entitlements, finance.commission_rules, finance.finance_visibility_read_model,
  finance.payouts, hotel_catalog.property_slugs, identity.auth_session_handoffs,
  identity.organization_resource_links, identity.permission_catalog, identity.product_entitlements,
  identity.role_permission_grants
  IN ACCESS EXCLUSIVE MODE;

-- Rows that still carry a removed value. 0493, 0498 and 0500 removed such grants, finance rows, links,
-- entitlements and visibility rows, so each check expects none.
DO $$
DECLARE
  retired_keys CONSTANT TEXT[] := ARRAY[
    'marketplace.affiliate.manage', 'marketplace.collaboration.read', 'marketplace.collaboration.review',
    'marketplace.collaboration.write', 'marketplace.finance.read', 'marketplace.profile.manage',
    'marketplace.trip.manage', 'marketplace.trip.read', 'affiliate.payout.manage'];
BEGIN
  IF EXISTS (
    SELECT 1 FROM identity.organization_resource_links
    WHERE product IN ('marketplace', 'affiliate')
       OR resource_type IN ('hotel_profile', 'marketplace_offer', 'creator_profile', 'affiliate')
       OR relationship = 'promotes'
  ) THEN
    RAISE EXCEPTION 'A resource link still names a Marketplace or affiliate value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM identity.product_entitlements
    WHERE product IN ('marketplace', 'affiliate') OR resource_product IN ('marketplace', 'affiliate')
       OR resource_type IN ('hotel_profile', 'marketplace_offer', 'creator_profile', 'affiliate')
  ) THEN
    RAISE EXCEPTION 'A product entitlement still names a Marketplace or affiliate value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM finance.finance_visibility_read_model
    WHERE visibility_scope = 'affiliate_payout' OR resource_type IN ('affiliate', 'marketplace')
       OR required_permission_key = ANY (retired_keys)
  ) THEN
    RAISE EXCEPTION 'A finance visibility row still names a Marketplace or affiliate value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM identity.role_permission_grants
    WHERE organization_kind IN ('creator_workspace', 'affiliate_partner') OR permission_key = ANY (retired_keys)
  ) THEN
    RAISE EXCEPTION 'A role grant still names a creator or affiliate kind or a retired permission';
  END IF;
  IF EXISTS (
    SELECT 1 FROM identity.organization_roles role_row
    CROSS JOIN LATERAL jsonb_array_elements_text(role_row.default_permissions) AS preset(key)
    WHERE preset.key = ANY (retired_keys)
  ) THEN
    RAISE EXCEPTION 'A role preset still lists a retired permission';
  END IF;
  IF EXISTS (
    SELECT 1 FROM hotel_catalog.property_slugs redirect
    JOIN hotel_catalog.property_slugs overlay ON overlay.id = redirect.redirects_to_id
    WHERE overlay.purpose = 'marketplace_overlay'
  ) THEN
    RAISE EXCEPTION 'A page address redirects to a Marketplace overlay address';
  END IF;
  IF EXISTS (
    SELECT 1 FROM finance.commission_rules
    WHERE product = 'affiliate' OR rule_scope = 'affiliate' OR affiliate_id IS NOT NULL
  ) OR EXISTS (SELECT 1 FROM finance.billing_entitlements WHERE product = 'affiliate') THEN
    RAISE EXCEPTION 'An affiliate commission rule or billing entitlement remains';
  END IF;
  -- pg_depend does not see plpgsql bodies: a trigger reading NEW.affiliate_id would break every write.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE prosrc ~ '\maffiliate_id\M') THEN
    RAISE EXCEPTION 'A function still names affiliate_id';
  END IF;
END $$;

-- The API refuses these surfaces since VAY-2271; open handoffs to or from them can only expire.
DELETE FROM identity.auth_session_handoffs
  WHERE source_surface IN ('marketplace-web', 'affiliate-dashboard')
     OR target_surface IN ('marketplace-web', 'affiliate-dashboard');
ALTER TABLE identity.auth_session_handoffs
  DROP CONSTRAINT chk_auth_session_handoffs_surfaces,
  ADD CONSTRAINT chk_auth_session_handoffs_surfaces CHECK (
    source_surface IN ('platform-admin', 'booking-admin', 'pms-web')
    AND target_surface IN ('platform-admin', 'booking-admin', 'pms-web')
    AND source_surface <> target_surface);

ALTER TABLE finance.finance_visibility_read_model
  DROP CONSTRAINT chk_finance_visibility_scope_shape,
  DROP CONSTRAINT chk_finance_visibility_scope_permission,
  DROP CONSTRAINT chk_finance_visibility_requires_permission,
  DROP CONSTRAINT finance_visibility_read_model_resource_type_check,
  DROP CONSTRAINT finance_visibility_read_model_visibility_scope_check,
  ADD CONSTRAINT finance_visibility_read_model_visibility_scope_check
    CHECK (visibility_scope IN ('property_finance', 'organization_finance', 'platform_finance')),
  ADD CONSTRAINT finance_visibility_read_model_resource_type_check
    CHECK (resource_type IN ('property', 'organization', 'platform')),
  ADD CONSTRAINT chk_finance_visibility_requires_permission
    CHECK (required_permission_key IN ('pms.finance.read', 'platform.finance.read')),
  ADD CONSTRAINT chk_finance_visibility_scope_permission CHECK (
    (visibility_scope = 'property_finance' AND required_permission_key = 'pms.finance.read')
    OR (visibility_scope IN ('platform_finance', 'organization_finance')
        AND required_permission_key = 'platform.finance.read')),
  ADD CONSTRAINT chk_finance_visibility_scope_shape CHECK (
    (visibility_scope = 'property_finance' AND resource_type = 'property' AND property_id IS NOT NULL
      AND resource_id = property_id::text)
    OR (visibility_scope = 'organization_finance' AND resource_type = 'organization' AND property_id IS NULL
      AND resource_id = organization_id::text)
    OR (visibility_scope = 'platform_finance' AND resource_type = 'platform' AND property_id IS NULL));

DELETE FROM identity.permission_catalog WHERE key IN (
  'marketplace.affiliate.manage', 'marketplace.collaboration.read', 'marketplace.collaboration.review',
  'marketplace.collaboration.write', 'marketplace.finance.read', 'marketplace.profile.manage',
  'marketplace.trip.manage', 'marketplace.trip.read', 'affiliate.payout.manage');

ALTER TABLE identity.role_permission_grants
  DROP CONSTRAINT role_permission_grants_organization_kind_check,
  ADD CONSTRAINT role_permission_grants_organization_kind_check
    CHECK (organization_kind IN ('platform', 'hotel_group'));

ALTER TABLE identity.organization_resource_links
  DROP CONSTRAINT chk_organization_resource_links_product,
  ADD CONSTRAINT chk_organization_resource_links_product
    CHECK (product IN ('platform', 'hotel_catalog', 'booking', 'pms')),
  DROP CONSTRAINT chk_organization_resource_links_resource_type,
  ADD CONSTRAINT chk_organization_resource_links_resource_type CHECK (resource_type IN (
    'platform', 'property', 'booking_hotel', 'pms_hotel', 'pms_property', 'payout_account')),
  DROP CONSTRAINT chk_organization_resource_links_relationship,
  ADD CONSTRAINT chk_organization_resource_links_relationship CHECK (relationship IN (
    'owner', 'operator', 'front_desk', 'finance_manager', 'billing_account'));

ALTER TABLE identity.product_entitlements
  DROP CONSTRAINT chk_product_entitlements_product,
  ADD CONSTRAINT chk_product_entitlements_product
    CHECK (product IN ('platform', 'hotel_catalog', 'booking', 'pms')),
  DROP CONSTRAINT chk_product_entitlements_resource_product,
  ADD CONSTRAINT chk_product_entitlements_resource_product CHECK (
    resource_product IS NULL OR resource_product IN ('platform', 'hotel_catalog', 'booking', 'pms')),
  DROP CONSTRAINT chk_product_entitlements_resource_type,
  ADD CONSTRAINT chk_product_entitlements_resource_type CHECK (resource_type IS NULL OR resource_type IN (
    'platform', 'property', 'booking_hotel', 'pms_hotel', 'pms_property', 'payout_account'));

-- Decision 9. Nothing redirects to them (checked above), and the Marketplace overlay pages are gone.
DELETE FROM hotel_catalog.property_slugs WHERE purpose = 'marketplace_overlay';
ALTER TABLE hotel_catalog.property_slugs
  DROP CONSTRAINT property_slugs_purpose_check,
  ADD CONSTRAINT property_slugs_purpose_check CHECK (purpose IN ('canonical', 'redirect'));

-- Only Marketplace collaborations (0008) and affiliate payment evidence items (0086) referenced these.
ALTER TABLE finance.commission_rules DROP CONSTRAINT uq_finance_commission_rules_id_organization;
ALTER TABLE finance.payouts DROP CONSTRAINT uq_finance_payouts_id_organization;

-- The affiliate values of commission rules (0007, 0087) and billing entitlements (0007).
DROP INDEX finance.uq_finance_active_property_affiliate_default,
  finance.uq_finance_active_property_affiliate_override;
ALTER TABLE finance.commission_rules
  DROP CONSTRAINT chk_finance_commission_rules_scope,
  DROP COLUMN affiliate_id,
  DROP CONSTRAINT commission_rules_rule_scope_check,
  ADD CONSTRAINT commission_rules_rule_scope_check
    CHECK (rule_scope IN ('property', 'organization', 'marketplace', 'platform', 'migration')),
  DROP CONSTRAINT commission_rules_product_check,
  ADD CONSTRAINT commission_rules_product_check
    CHECK (product IN ('platform', 'marketplace', 'booking', 'pms')),
  ADD CONSTRAINT chk_finance_commission_rules_scope CHECK (
    (rule_scope = 'property' AND property_id IS NOT NULL)
    OR (rule_scope IN ('organization', 'marketplace') AND organization_id IS NOT NULL)
    OR (rule_scope = 'platform' AND property_id IS NULL AND organization_id IS NULL)
    OR rule_scope = 'migration');
ALTER TABLE finance.billing_entitlements
  DROP CONSTRAINT billing_entitlements_product_check,
  ADD CONSTRAINT billing_entitlements_product_check
    CHECK (product IN ('platform', 'marketplace', 'booking', 'pms'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid IN (
        'identity.auth_session_handoffs'::regclass, 'finance.finance_visibility_read_model'::regclass,
        'identity.role_permission_grants'::regclass, 'identity.organization_resource_links'::regclass,
        'identity.product_entitlements'::regclass, 'hotel_catalog.property_slugs'::regclass)
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) ~ 'marketplace|affiliate|creator|promotes|hotel_profile'
  ) OR EXISTS (
    -- Their marketplace values stay.
    SELECT 1 FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid IN (
        'finance.commission_rules'::regclass, 'finance.billing_entitlements'::regclass)
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) ~ 'affiliate'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'finance.commission_rules'::regclass AND attname = 'affiliate_id' AND NOT attisdropped
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname = 'finance' AND indexname LIKE '%affiliate%'
  ) OR EXISTS (
    SELECT 1 FROM identity.permission_catalog WHERE product IN ('marketplace', 'affiliate')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE (conrelid = 'finance.commission_rules'::regclass AND conname = 'uq_finance_commission_rules_id_organization')
       OR (conrelid = 'finance.payouts'::regclass AND conname = 'uq_finance_payouts_id_organization')
  ) THEN
    RAISE EXCEPTION 'Marketplace or affiliate values remain';
  END IF;
END $$;
