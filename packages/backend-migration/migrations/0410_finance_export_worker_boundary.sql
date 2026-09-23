-- VAY-2045: Financials export-only worker boundary. No role, grants or enabled properties.
CREATE TABLE platform.finance_export_worker_properties (
  property_id uuid PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT
);
COMMENT ON TABLE platform.finance_export_worker_properties IS
  'Owner-managed, empty-by-default scope for the dedicated Financials export worker.';

-- SECURITY INVOKER and the early return keep existing roles independent of the
-- worker-only allowlist while preserving RLS on every referenced relation.
CREATE FUNCTION platform.finance_export_worker_scope(kind text, resource text, parent uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'vayada_next_finance_export_worker' THEN RETURN true; END IF;
  CASE kind
    WHEN 'property' THEN RETURN EXISTS (
      SELECT 1 FROM platform.finance_export_worker_properties WHERE property_id::text = resource);
    WHEN 'job' THEN RETURN EXISTS (
      SELECT 1 FROM platform.jobs WHERE id::text = resource AND (parent IS NULL OR property_id = parent));
    WHEN 'attempt' THEN RETURN EXISTS (
      SELECT 1 FROM platform.job_attempts WHERE id::text = resource AND job_id = parent);
    ELSE RETURN false;
  END CASE;
END;
$$;

-- Keep the existing identity runtime policy from making every dead-letter
-- writer inherit SELECT on WorkOS receipts. The invoker helper is only
-- evaluated for the identity login, which already owns that read boundary.
CREATE FUNCTION platform.identity_runtime_dead_letter_webhook_scope(webhook_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM platform.external_webhook_events receipt
    WHERE receipt.id = webhook_id AND receipt.provider = 'workos'
  );
END;
$$;
DROP POLICY identity_runtime_scope ON platform.dead_letter_events;
CREATE POLICY identity_runtime_scope ON platform.dead_letter_events TO PUBLIC USING (
  current_user <> 'vayada_next_identity_runtime'
  OR (source_kind = 'webhook' AND resource_product = 'identity'
      AND resource_type = 'workos_webhook'
      AND platform.identity_runtime_dead_letter_webhook_scope(webhook_event_id))
);

CREATE POLICY finance_export_worker_scope ON platform.jobs AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_export_worker' OR (
    tenant_scope = 'property'
    AND platform.finance_export_worker_scope('property', property_id::text)
    AND queue_name = 'finance.financials-exports'
    AND job_type IN ('finance.folio-csv-export.v1','finance.expense-csv-export.v1',
      'finance.profit-loss-csv-export.v1','finance.revenue-csv-export.v1',
      'finance.dashboard-csv-export.v1')
    AND resource_product = 'finance' AND resource_type = 'financials_export'
    AND resource_id = id::text
  ));

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='platform.job_attempts'::regclass) THEN
    ALTER TABLE platform.job_attempts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY finance_export_worker_compat ON platform.job_attempts TO PUBLIC USING (true);
  END IF;
END $$;
CREATE POLICY finance_export_worker_scope ON platform.job_attempts AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_export_worker'
    OR platform.finance_export_worker_scope('job', job_id::text));

CREATE POLICY finance_export_worker_scope ON platform.dead_letter_events AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_export_worker' OR (
    tenant_scope = 'property' AND source_kind = 'job' AND resource_product = 'finance'
    AND resource_type = 'financials_export' AND resource_id = job_id::text
    AND platform.finance_export_worker_scope('property', property_id::text)
    AND platform.finance_export_worker_scope('job', job_id::text, property_id)
    AND (job_attempt_id IS NULL OR platform.finance_export_worker_scope('attempt', job_attempt_id::text, job_id))
    AND (requeued_job_id IS NULL OR requeued_job_id = job_id)
  ));

CREATE POLICY finance_export_worker_scope ON platform.product_audit_events AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_export_worker' OR (
    tenant_scope = 'property' AND product = 'finance' AND actor_type = 'system'
    AND target_resource_product = 'finance' AND target_resource_type = 'financials_export'
    AND target_resource_id = job_id::text
    AND action ~ '^finance\.(folio|expense|profit_loss|revenue|dashboard)_export\.(succeeded|retry_scheduled|dead_lettered)$'
    AND platform.finance_export_worker_scope('property', property_id::text)
    AND platform.finance_export_worker_scope('job', job_id::text, property_id)
  ));

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='platform.media_objects'::regclass) THEN
    ALTER TABLE platform.media_objects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY finance_export_worker_compat ON platform.media_objects TO PUBLIC USING (true);
  END IF;
END $$;
CREATE POLICY finance_export_worker_scope ON platform.media_objects AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_export_worker' OR (
    visibility = 'private' AND purpose = 'finance.financials_export'
    AND resource_product = 'finance' AND resource_type = 'financials_export'
    AND resource_id = id::text AND source_system = 'platform'
    AND source_table = 'platform.jobs' AND source_row_id = id::text
    AND platform.finance_export_worker_scope('property', property_id::text)
    AND platform.finance_export_worker_scope('job', id::text, property_id)
  ));

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('hotel_catalog.properties','id'),
    ('hotel_catalog.property_locations','property_id'),
    ('pms.property_pricing_settings','property_id'),
    ('finance.expenses','property_id'),
    ('finance.folios','property_id'),
    ('finance.folio_revisions','property_id'),
    ('finance.folio_lines','property_id'),
    ('finance.folio_payment_references','property_id')
  ) AS scope(relation,property_column) LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=item.relation::regclass) THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item.relation);
      EXECUTE format('CREATE POLICY finance_export_worker_compat ON %s TO PUBLIC USING(true)',item.relation);
    END IF;
    EXECUTE format('CREATE POLICY finance_export_worker_scope ON %s AS RESTRICTIVE TO PUBLIC USING
      (current_user <> ''vayada_next_finance_export_worker'' OR
       platform.finance_export_worker_scope(''property'',%I::text))',item.relation,item.property_column);
  END LOOP;
END $$;
