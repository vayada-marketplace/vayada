-- VAY-2108 D3a: ongoing offer ARI delivery scope (engineering/channex-ongoing-offer-ari.md).
-- The 0520 delivery tables get the Channex management worker's row security, following 0408's
-- source scope: a delivery follows its target, its dates and receipts follow the delivery. The
-- worker's grants on these tables come from the platform's delivery grant mode, never from here.
-- Moving a target's active version (a new provider configuration or binding) closes its sales,
-- so a new rate plan never opens without a new audited open-sales command.
SET LOCAL lock_timeout = '5s';

-- Like 0408's worker_source (pinned, never rewritten) it returns true for every other current_user
-- before reading worker tables, so it keeps PUBLIC execution and no policy consumer needs a grant.
CREATE FUNCTION platform.channex_management_worker_delivery_source(kind text, resource text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'vayada_next_channex_management_worker' THEN RETURN true; END IF;
  IF resource IS NULL OR resource !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  CASE kind
    WHEN 'delivery' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channex_offer_ari_deliveries WHERE id = resource::uuid);
    ELSE RETURN false;
  END CASE;
END;
$$;

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('pms.channex_offer_ari_deliveries','platform.channex_management_worker_source(''target'',target_id::text)'),
    ('pms.channex_offer_ari_delivery_dates','platform.channex_management_worker_delivery_source(''delivery'',delivery_id::text)'),
    ('pms.channex_offer_ari_delivery_receipts','platform.channex_management_worker_delivery_source(''delivery'',delivery_id::text)')
  ) AS scope(relation,predicate) LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=item.relation::regclass) THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item.relation);
      EXECUTE format('CREATE POLICY channex_management_worker_compat ON %s TO PUBLIC USING(true)',item.relation);
    END IF;
    EXECUTE format('CREATE POLICY channex_management_worker_scope ON %s AS RESTRICTIVE TO PUBLIC USING
      (current_user <> ''vayada_next_channex_management_worker'' OR (%s))',item.relation,item.predicate);
  END LOOP;
END $$;

-- Sales close whenever the active version moves. The audited open-sales command is the only way
-- back to 'open' (0520 keeps sales_state_changed_at non-null for an open state).
CREATE FUNCTION pms.close_channex_offer_sales_on_version_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_version IS DISTINCT FROM OLD.active_version AND NEW.sales_state <> 'closed' THEN
    NEW.sales_state := 'closed';
    NEW.sales_state_changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_offer_target_sales_reset BEFORE UPDATE OF active_version
  ON pms.channex_offer_targets FOR EACH ROW
  EXECUTE FUNCTION pms.close_channex_offer_sales_on_version_move();
