-- VAY-2041: PMS/source boundary; no credentials, grants or enabled properties.
-- All helper lookups retain invoker privileges and the referenced table's RLS.
CREATE FUNCTION platform.channex_management_worker_source(kind text, resource text, parent uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'vayada_next_channex_management_worker' THEN RETURN true; END IF;
  CASE kind
    WHEN 'organization' THEN RETURN EXISTS (
      SELECT 1 FROM identity.organization_resource_links WHERE organization_id = resource::uuid);
    WHEN 'connection' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channel_connections WHERE id = resource::uuid AND (parent IS NULL OR property_id = parent));
    WHEN 'target' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channex_offer_targets WHERE id = resource::uuid AND (parent IS NULL OR connection_id = parent));
    WHEN 'creation' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channex_offer_create_attempts WHERE id = resource::uuid);
    WHEN 'ari' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channex_offer_ari_attempts WHERE id = resource::uuid);
    WHEN 'availability' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channex_room_availability_attempts WHERE id = resource::uuid);
    ELSE RETURN false;
  END CASE;
END;
$$;

-- Native RLS cannot turn UPDATE privilege into a row-lock-only privilege.
-- A restrictive UPDATE WITH CHECK denies actual edits while USING allows locks.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('hotel_catalog.properties','id',true),
    ('hotel_catalog.property_locations','property_id',true),
    ('finance.payment_settings','property_id',true),
    ('finance.payment_provider_accounts','property_id',true),
    ('finance.online_card_execution_evidence','property_id',true),
    ('booking.pricing_v2_offer_term_heads','property_id',true),
    ('booking.pricing_v2_offer_terms','property_id',false),
    ('booking.fixed_charge_heads','property_id',true),
    ('booking.fixed_charge_revisions','property_id',true),
    ('booking.same_day_booking_policies','property_id',false),
    ('pms.room_types','property_id',true),
    ('pms.rooms','property_id',false),
    ('pms.room_type_closures','property_id',false),
    ('pms.property_pricing_settings','property_id',false),
    ('pms.rate_plans','property_id',false),
    ('pms.recurring_pricing_sources','property_id',false),
    ('pms.recurring_pricing_source_room_values','property_id',false),
    ('pms.channel_date_prices','property_id',false),
    ('pms.pricing_v2_heads','property_id',false),
    ('pms.pricing_v2_revisions','property_id',false),
    ('pms.pricing_v2_rooms','property_id',false),
    ('pms.pricing_v2_charge_declarations','property_id',false),
    ('pms.operating_calendar_revisions','property_id',true),
    ('pms.operating_calendar_recurring_periods','property_id',false),
    ('pms.operating_calendar_room_bindings','property_id',false),
    ('pms.inventory_days','property_id',true),
    ('pms.inventory_materialization_coverage','property_id',true),
    ('pms.channex_ari_schedule_sources','property_id',false)
  ) AS scope(relation,property_column,lock_only) LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=item.relation::regclass) THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item.relation);
      EXECUTE format('CREATE POLICY channex_management_worker_compat ON %s TO PUBLIC USING(true)',item.relation);
    END IF;
    EXECUTE format('CREATE POLICY channex_management_worker_scope ON %s AS RESTRICTIVE TO PUBLIC USING
      (current_user <> ''vayada_next_channex_management_worker'' OR platform.channex_management_worker_scope(''property'',%I::text))',item.relation,item.property_column);
    IF item.lock_only THEN
      EXECUTE format('CREATE POLICY channex_management_worker_lock_only ON %s AS RESTRICTIVE FOR UPDATE TO PUBLIC
        USING(true) WITH CHECK(current_user <> ''vayada_next_channex_management_worker'')',item.relation);
    END IF;
  END LOOP;
END $$;

-- Follow persisted ownership for rows without property_id. Keep all entitlement
-- rows of a scoped organization visible: authority locks them against retargeting.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('identity.organization_resource_links',
      '(product,resource_type) IN ((''hotel_catalog'',''property''),(''pms'',''pms_property'')) AND platform.channex_management_worker_scope(''property'',resource_id)',true),
    ('identity.organizations','platform.channex_management_worker_source(''organization'',id::text)',true),
    ('identity.product_entitlements','platform.channex_management_worker_source(''organization'',organization_id::text)',true),
    ('pms.channel_connections','provider=''channex'' AND platform.channex_management_worker_scope(''property'',property_id::text)',false),
    ('pms.channel_binding_claims','provider=''channex'' AND platform.channex_management_worker_scope(''property'',property_id::text)',true),
    ('pms.channel_room_type_mappings','platform.channex_management_worker_source(''connection'',connection_id::text,property_id)',true),
    ('pms.channel_rate_plan_mappings','platform.channex_management_worker_source(''connection'',connection_id::text,property_id)',false),
    ('pms.channel_sync_status','sync_domain IN (''ari'',''mapping'') AND platform.channex_management_worker_source(''connection'',connection_id::text,property_id)',false),
    ('pms.channex_offer_targets','platform.channex_management_worker_source(''connection'',connection_id::text,property_id)',false),
    ('pms.channex_offer_target_intents','platform.channex_management_worker_source(''target'',target_id::text)',false),
    ('pms.channex_offer_target_versions','platform.channex_management_worker_source(''target'',target_id::text)',false),
    ('pms.channex_external_rate_owners','owner_kind=''offer'' AND legacy_identity IS NULL AND platform.channex_management_worker_source(''target'',owner_id::text,connection_id)',false),
    ('pms.channex_offer_create_attempts','platform.channex_management_worker_source(''target'',target_id::text)',false),
    ('pms.channex_offer_create_receipts','platform.channex_management_worker_source(''creation'',attempt_id::text)',false),
    ('pms.channex_offer_ari_attempts','platform.channex_management_worker_source(''target'',target_id::text)',false),
    ('pms.channex_offer_ari_receipts','platform.channex_management_worker_source(''ari'',attempt_id::text)',false),
    ('pms.channex_room_availability_attempts','platform.channex_management_worker_source(''connection'',connection_id::text,property_id)',false),
    ('pms.channex_room_availability_receipts','platform.channex_management_worker_source(''availability'',attempt_id::text)',false),
    ('pms.channex_room_availability_reconciliation_attestations','platform.channex_management_worker_source(''availability'',attempt_id::text)',false)
  ) AS scope(relation,predicate,lock_only) LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=item.relation::regclass) THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item.relation);
      EXECUTE format('CREATE POLICY channex_management_worker_compat ON %s TO PUBLIC USING(true)',item.relation);
    END IF;
    EXECUTE format('CREATE POLICY channex_management_worker_scope ON %s AS RESTRICTIVE TO PUBLIC USING
      (current_user <> ''vayada_next_channex_management_worker'' OR (%s))',item.relation,item.predicate);
    IF item.lock_only THEN
      EXECUTE format('CREATE POLICY channex_management_worker_lock_only ON %s AS RESTRICTIVE FOR UPDATE TO PUBLIC
        USING(true) WITH CHECK(current_user <> ''vayada_next_channex_management_worker'')',item.relation);
    END IF;
  END LOOP;
END $$;

-- The view otherwise reads with its owner's RLS bypass. All its source tables
-- are part of the reviewed read/lock matrix; no Finance write is allowed.
ALTER VIEW finance.online_card_readiness SET (security_invoker = true);

-- The legacy success statement SETs these fields even when preserving their
-- values. Permit that statement while forbidding any worker binding/config edit.
CREATE FUNCTION pms.guard_channex_worker_connection_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user = 'vayada_next_channex_management_worker' AND
    (to_jsonb(NEW)-'last_ari_sync_at'-'updated_at') IS DISTINCT FROM
    (to_jsonb(OLD)-'last_ari_sync_at'-'updated_at') THEN
    RAISE EXCEPTION 'Channex worker connection identity is read only' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_worker_connection_update BEFORE UPDATE ON pms.channel_connections
  FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_worker_connection_update();
