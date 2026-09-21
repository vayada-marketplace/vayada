-- VAY-2044: Finance-only worker boundary. No role, grants or enabled properties.
-- Owners retain migration authority; the worker must never own objects or BYPASSRLS.
CREATE TABLE platform.finance_expense_worker_properties (
  property_id uuid PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT
);
COMMENT ON TABLE platform.finance_expense_worker_properties IS
  'Owner-managed, empty by default; reviewed bounded Finance worker scope. Never runtime-writable.';

-- Invoker-only lookups avoid eager subquery ACL checks for existing roles.
-- No elevated authority: the Finance caller still needs the exact underlying
-- grants and is filtered by each referenced table's restrictive policies.
CREATE FUNCTION platform.finance_expense_worker_scope(kind text, resource text, parent uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'vayada_next_finance_expense_worker' THEN RETURN true; END IF;
  CASE kind
    WHEN 'property' THEN RETURN EXISTS (
      SELECT 1 FROM platform.finance_expense_worker_properties WHERE property_id::text = resource);
    WHEN 'job' THEN RETURN EXISTS (
      SELECT 1 FROM platform.jobs WHERE id::text = resource AND (parent IS NULL OR property_id = parent));
    WHEN 'attempt' THEN RETURN EXISTS (
      SELECT 1 FROM platform.job_attempts WHERE id::text = resource AND job_id = parent);
    WHEN 'key' THEN RETURN EXISTS (
      SELECT 1 FROM platform.idempotency_keys WHERE id::text = resource AND property_id = parent);
    WHEN 'organization' THEN RETURN EXISTS (
      SELECT 1 FROM identity.organization_resource_links WHERE organization_id::text = resource);
    ELSE RETURN false;
  END CASE;
END;
$$;

ALTER TABLE platform.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_scope ON platform.jobs AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (tenant_scope = 'property' AND platform.finance_expense_worker_scope('property', property_id::text) AND queue_name = 'finance.expense-generation' AND job_type = 'finance.generate-expense' AND resource_product = 'finance'));

ALTER TABLE platform.job_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON platform.job_attempts TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON platform.job_attempts AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('job', job_id::text)));

ALTER TABLE platform.dead_letter_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_scope ON platform.dead_letter_events AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (tenant_scope = 'property' AND platform.finance_expense_worker_scope('property', property_id::text) AND source_kind = 'job' AND resource_product = 'finance' AND platform.finance_expense_worker_scope('job', job_id::text, property_id) AND (job_attempt_id IS NULL OR platform.finance_expense_worker_scope('attempt', job_attempt_id::text, job_id)) AND (requeued_job_id IS NULL OR requeued_job_id = job_id)));

ALTER TABLE platform.idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_scope ON platform.idempotency_keys AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (tenant_scope = 'property' AND platform.finance_expense_worker_scope('property', property_id::text) AND operation_scope = 'finance' AND operation = 'finance.generated_expense.execute'));

ALTER TABLE platform.product_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_scope ON platform.product_audit_events AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (tenant_scope = 'property' AND platform.finance_expense_worker_scope('property', property_id::text) AND product = 'finance' AND target_resource_product = 'finance' AND actor_type = 'system' AND (starts_with(action, 'finance.expense_generation.') OR action = 'finance.generated_expense.execute') AND (job_id IS NULL OR platform.finance_expense_worker_scope('job', job_id::text, property_id)) AND (idempotency_key_id IS NULL OR platform.finance_expense_worker_scope('key', idempotency_key_id::text, property_id))));

ALTER TABLE finance.expense_generation_dispatches ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON finance.expense_generation_dispatches TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON finance.expense_generation_dispatches AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', property_id::text)));

ALTER TABLE finance.recurring_expense_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON finance.recurring_expense_rules TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON finance.recurring_expense_rules AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', property_id::text)));

ALTER TABLE finance.expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON finance.expense_categories TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON finance.expense_categories AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', property_id::text)));
-- Row locks require UPDATE privilege; actual UPDATE remains forbidden.
CREATE POLICY finance_expense_worker_lock_only ON finance.expense_categories AS RESTRICTIVE
  FOR UPDATE TO PUBLIC USING (true) WITH CHECK (current_user <> 'vayada_next_finance_expense_worker');

ALTER TABLE finance.ota_commission_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON finance.ota_commission_evidence TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON finance.ota_commission_evidence AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', property_id::text)));
-- Row locks require UPDATE privilege; actual UPDATE remains forbidden.
CREATE POLICY finance_expense_worker_lock_only ON finance.ota_commission_evidence AS RESTRICTIVE
  FOR UPDATE TO PUBLIC USING (true) WITH CHECK (current_user <> 'vayada_next_finance_expense_worker');

ALTER TABLE finance.provider_fee_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON finance.provider_fee_evidence TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON finance.provider_fee_evidence AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', property_id::text)));
-- Row locks require UPDATE privilege; actual UPDATE remains forbidden.
CREATE POLICY finance_expense_worker_lock_only ON finance.provider_fee_evidence AS RESTRICTIVE
  FOR UPDATE TO PUBLIC USING (true) WITH CHECK (current_user <> 'vayada_next_finance_expense_worker');

ALTER TABLE booking.nightly_revenue_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON booking.nightly_revenue_evidence TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON booking.nightly_revenue_evidence AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', property_id::text)));
-- Row locks require UPDATE privilege; actual UPDATE remains forbidden.
CREATE POLICY finance_expense_worker_lock_only ON booking.nightly_revenue_evidence AS RESTRICTIVE
  FOR UPDATE TO PUBLIC USING (true) WITH CHECK (current_user <> 'vayada_next_finance_expense_worker');

ALTER TABLE hotel_catalog.property_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON hotel_catalog.property_locations TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON hotel_catalog.property_locations AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', property_id::text)));

ALTER TABLE pms.property_pricing_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON pms.property_pricing_settings TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON pms.property_pricing_settings AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', property_id::text)));
-- Row locks require UPDATE privilege; actual UPDATE remains forbidden.
CREATE POLICY finance_expense_worker_lock_only ON pms.property_pricing_settings AS RESTRICTIVE
  FOR UPDATE TO PUBLIC USING (true) WITH CHECK (current_user <> 'vayada_next_finance_expense_worker');

ALTER TABLE hotel_catalog.properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON hotel_catalog.properties TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON hotel_catalog.properties AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', id::text)));
-- Row locks require UPDATE privilege; actual UPDATE remains forbidden.
CREATE POLICY finance_expense_worker_lock_only ON hotel_catalog.properties AS RESTRICTIVE
  FOR UPDATE TO PUBLIC USING (true) WITH CHECK (current_user <> 'vayada_next_finance_expense_worker');

ALTER TABLE finance.expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON finance.expenses TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON finance.expenses AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('property', property_id::text) AND origin IN ('recurring','ota_commission','platform_fee') AND receipt_media_id IS NULL));
-- Row locks require UPDATE privilege; actual UPDATE remains forbidden.
CREATE POLICY finance_expense_worker_lock_only ON finance.expenses AS RESTRICTIVE
  FOR UPDATE TO PUBLIC USING (true) WITH CHECK (current_user <> 'vayada_next_finance_expense_worker');

ALTER TABLE identity.organization_resource_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON identity.organization_resource_links TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON identity.organization_resource_links AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (product = 'pms' AND resource_type = 'pms_property' AND platform.finance_expense_worker_scope('property', resource_id)));

ALTER TABLE identity.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON identity.organizations TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON identity.organizations AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('organization', id::text)));

ALTER TABLE identity.product_entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_expense_worker_compat ON identity.product_entitlements TO PUBLIC USING (true);
CREATE POLICY finance_expense_worker_scope ON identity.product_entitlements AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker' OR (platform.finance_expense_worker_scope('organization', organization_id::text) AND product = 'pms' AND entitlement_key IN ('module:financials','property-management') AND (resource_product IS NULL OR (resource_product = 'pms' AND resource_type = 'pms_property' AND platform.finance_expense_worker_scope('property', resource_id)))));

-- Existing identity dead-letter policy reads these two receipt columns even for
-- another role. Permit the policy lookup, but expose zero receipt rows to Finance.
CREATE POLICY finance_expense_worker_scope ON platform.external_webhook_events AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_finance_expense_worker');
