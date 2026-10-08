-- VAY-2056 decommission step 6: retire the native hotel-setup database objects.
--
-- Hotel setup runs on the ordinary API login since the VAY-2056 release; both private
-- hotel-setup services are stopped and their code is gone. This drops what only the native
-- per-hotel logins used: their triggers, policies, view, functions and scope tables, and
-- revokes the grants the migration owner gave their roles. It ends the image-only rollback
-- window: every older next-API image fails its pinned startup checks after this runs.
--
-- Kept, because they apply to every writer (design note §12):
--   identity.product_entitlements.entitlement_routing_organization_lock (0447)
--   platform.media_upload_sessions.hotel_setup_media_session_allocation_guard (0468)
-- The roles themselves are dropped afterwards by vayada_admin (the migration login has no
-- CREATEROLE); see engineering/hotel-setup-ordinary-login.md §12.
SET LOCAL lock_timeout = '5s';

-- 0. Every table this migration alters, locked up front in one statement and a fixed order, so
-- a busy table makes the run time out before anything changes instead of midway. The tables that
-- carry a hotel_setup policy are also remembered for the final permissive-coverage check.
CREATE TEMPORARY TABLE retired_policy_tables ON COMMIT DROP AS
SELECT DISTINCT p.polrelid AS relation
FROM pg_catalog.pg_policy p
WHERE p.polname LIKE 'hotel\_setup\_%';

DO $$
DECLARE targets TEXT;
BEGIN
  SELECT string_agg(relation::regclass::text, ', ' ORDER BY relation::regclass::text) INTO targets
  FROM (
    SELECT relation FROM retired_policy_tables
    UNION
    SELECT t.tgrelid FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND (t.tgname ~ 'hotel_setup' OR p.proname ~ 'hotel_setup')
    UNION
    SELECT c.oid FROM pg_catalog.pg_class c
    WHERE c.relname ~ '^hotel_setup_' AND c.relkind IN ('r', 'v')
  ) affected (relation);
  EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', targets);
END $$;

-- 1. Native Owner-off receipts become ordinary markers before their guard trigger goes. The
-- ordinary marker counts while it equals the row's xmin, i.e. this transaction's id, so a
-- receipt that was valid stays valid until the next write to its row, as before.
DROP TRIGGER hotel_setup_owner_off_receipt ON identity.product_entitlements;
UPDATE identity.product_entitlements
SET metadata = (metadata - 'newHotelFinancialsOwnerDisabled')
  || jsonb_build_object('featureHubOwnerDisabled', pg_current_xact_id()::xid::text)
WHERE metadata->'newHotelFinancialsOwnerDisabled' = 'true'::jsonb;
UPDATE identity.product_entitlements
SET metadata = metadata - 'newHotelFinancialsOwnerDisabled'
WHERE metadata ? 'newHotelFinancialsOwnerDisabled';

-- 2. Triggers. All of them return early for every login except the native ones, apart from
-- record_hotel_setup_owner_link, which only fills platform.hotel_setup_linked_properties (dropped
-- below; nothing else reads it).
DROP TRIGGER hotel_setup_logo_profile_revision_guard ON hotel_catalog.properties;
DROP TRIGGER record_hotel_setup_owner_link ON identity.organization_resource_links;
DROP TRIGGER hotel_setup_completion_evidence ON platform.domain_events;
DROP TRIGGER hotel_setup_completion_evidence ON platform.idempotency_keys;
DROP TRIGGER hotel_setup_creation_key_completion ON platform.idempotency_keys;
DROP TRIGGER hotel_setup_completion_evidence ON platform.outbox_events;
DROP TRIGGER hotel_setup_completion_evidence ON platform.product_audit_events;
DROP TRIGGER hotel_setup_feature_hub_apply ON platform.product_audit_events;
DROP TRIGGER hotel_setup_feature_hub_command ON platform.product_audit_events;
DROP TRIGGER hotel_setup_completion_currency_seal ON pms.property_pricing_settings;
DROP TRIGGER hotel_setup_first_currency_completion ON pms.property_pricing_settings;

-- 3. Policies. Every hotel_setup_* policy only restricts or admits the native logins; none
-- restricts the API login. Several call pg_has_role on a hotel-setup role name, so they must
-- go before any role is dropped.
DO $$
DECLARE policy RECORD;
BEGIN
  FOR policy IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, p.polname AS policy_name
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE p.polname LIKE 'hotel\_setup\_%'
    ORDER BY 1, 2, 3
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', policy.policy_name, policy.schema_name, policy.table_name);
  END LOOP;
END $$;

-- On these 15 tables a hotel-setup migration first enabled RLS and a hotel-setup policy was the
-- only permissive one. With it gone RLS would deny every login but the owner; turning RLS off
-- restores their state before hotel setup, which is what every caller saw through those
-- policies. RLS is not forced on any of them.
DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'booking.booking_settings', 'finance.billing_entitlements',
    'hotel_catalog.organization_setup_track_intents', 'hotel_catalog.property_contact_channels',
    'hotel_catalog.property_media', 'hotel_catalog.property_owner_revisions',
    'hotel_catalog.property_profiles', 'hotel_catalog.property_public_profile_read_model',
    'identity.organization_roles', 'marketplace.marketplace_hotel_profiles',
    'platform.domain_events', 'platform.media_upload_sessions', 'platform.media_variants',
    'platform.outbox_events', 'pms.rate_rules'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = target::regclass) THEN
      RAISE EXCEPTION 'Table % still has a policy; RLS stays on', target;
    END IF;
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', target::regclass);
  END LOOP;
END $$;

-- 4. View, functions and scope tables.
DROP VIEW hotel_catalog.hotel_setup_effective_creation_scopes;

DO $$
DECLARE routine RECORD;
BEGIN
  FOR routine IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'platform'
      AND p.proname ~ 'hotel_setup'
      AND p.proname <> 'hotel_setup_media_session_allocation_guard'
    ORDER BY 1::text
  LOOP
    EXECUTE format('DROP FUNCTION %s', routine.signature);
  END LOOP;
END $$;

DROP TABLE platform.hotel_setup_creation_scopes;
DROP TABLE platform.hotel_setup_linked_properties;
DROP TABLE platform.hotel_setup_property_scopes;
DROP TABLE platform.hotel_setup_reconciliation_cursors;

-- 5. Grants this owner gave the hotel-setup roles on objects that stay. Grants by other
-- grantors (vayada_admin, on production) are revoked by the role-drop step.
DO $$
DECLARE grant_row RECORD;
BEGIN
  FOR grant_row IN
    SELECT DISTINCT format('REVOKE ALL ON TABLE %s FROM %I', c.oid::regclass, r.rolname) AS statement
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE r.rolname ~ '^vayada_next_hotel_setup_' AND a.grantor = c.relowner
    UNION
    SELECT DISTINCT format('REVOKE ALL (%I) ON TABLE %s FROM %I', attribute.attname, c.oid::regclass, r.rolname)
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class c ON c.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE r.rolname ~ '^vayada_next_hotel_setup_' AND a.grantor = c.relowner
    UNION
    SELECT DISTINCT format('REVOKE ALL ON FUNCTION %s FROM %I', p.oid::regprocedure, r.rolname)
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE r.rolname ~ '^vayada_next_hotel_setup_' AND a.grantor = p.proowner
    UNION
    SELECT DISTINCT format('REVOKE ALL ON SCHEMA %I FROM %I', n.nspname, r.rolname)
    FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE r.rolname ~ '^vayada_next_hotel_setup_' AND a.grantor = n.nspowner
    ORDER BY 1
  LOOP
    EXECUTE grant_row.statement;
  END LOOP;
END $$;

-- 6. Nothing of the native protocol may remain, and no table that carried a hotel_setup policy
-- may be left with RLS on but no permissive policy (it would silently deny every non-owner login).
DO $$
DECLARE denied TEXT;
BEGIN
  SELECT string_agg(c.oid::regclass::text, ', ') INTO denied
  FROM retired_policy_tables retired
  JOIN pg_catalog.pg_class c ON c.oid = retired.relation
  WHERE c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive);
  IF denied IS NOT NULL THEN
    RAISE EXCEPTION 'RLS left on without a permissive policy: %', denied;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname LIKE 'hotel\_setup\_%')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND (t.tgname ~ 'hotel_setup' OR p.proname ~ 'hotel_setup')
        AND t.tgname <> 'hotel_setup_media_session_allocation_guard')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname ~ 'hotel_setup'
      AND proname <> 'hotel_setup_media_session_allocation_guard')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname ~ 'hotel_setup')
    OR EXISTS (SELECT 1 FROM identity.product_entitlements WHERE metadata ? 'newHotelFinancialsOwnerDisabled')
  THEN
    RAISE EXCEPTION 'Native hotel-setup objects remain';
  END IF;
END $$;
