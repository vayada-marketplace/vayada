import { createHash } from "node:crypto";
import type pg from "pg";

export const FINANCE_EXPENSE_WORKER_ROLE = "vayada_next_finance_expense_worker";
// Migration 0409 grants these views to PUBLIC, but their validated source-table
// check excludes non-pricing logins and both security-barrier views return no rows.
const pricingScopeViews = new Set([
  "booking.pricing_runtime_effective_property_scopes",
  "booking.pricing_runtime_effective_authority_scopes",
]);
const PRICING_SCOPE_VIEW_DIGEST =
  "4719b0dcc4f7255410e6d5c993541ff106a8acbf09f521bc9d2819a5fdbb1797";
const PRICING_LOGIN_CHECK =
  "CHECK (((database_login)::text ~ '^vayada_next_pricing_[a-z0-9_]+$'::text))";
// Exact grant contract. A column list never permits table-level authority.
// prettier-ignore
export const financeExpenseWorkerPrivileges: Record<string, Record<string, true | string[]>> = {
  "platform.external_webhook_events": { SELECT: ["id", "provider"] },
  "platform.finance_expense_worker_properties": { SELECT: true },
  "hotel_catalog.properties": { SELECT: true, UPDATE: ["id"] },
  "hotel_catalog.property_locations": { SELECT: true },
  "pms.property_pricing_settings": { SELECT: true, UPDATE: ["property_id"] },
  "identity.organizations": { SELECT: ["id", "kind", "status"] },
  "identity.organization_resource_links": { SELECT: ["organization_id", "product", "resource_type", "resource_id", "relationship", "status"] },
  "identity.product_entitlements": { SELECT: ["organization_id", "product", "entitlement_key", "status", "resource_product", "resource_type", "resource_id", "starts_at", "expires_at"] },
  "finance.expense_categories": { SELECT: true, UPDATE: ["id"] },
  "finance.ota_commission_evidence": { SELECT: true, UPDATE: ["id"] },
  "finance.provider_fee_evidence": { SELECT: true, UPDATE: ["id"] },
  "booking.nightly_revenue_evidence": { SELECT: true, UPDATE: ["id"] },
  "finance.recurring_expense_rules": { SELECT: true, UPDATE: ["next_due_on", "active", "revision", "updated_at"] },
  "finance.expense_generation_dispatches": { SELECT: true, UPDATE: ["dispatched_at", "discovery_attempts", "run_after", "last_error_code"] },
  "finance.expenses": { SELECT: true, UPDATE: ["id"], INSERT: ["id", "property_id", "category_id", "origin", "entry_kind", "incurred_on", "paid_on", "vendor", "description", "amount", "currency", "payment_status", "recurring_rule_id", "source_key", "reverses_expense_id", "guest_booking_id", "payment_id"] },
  "platform.jobs": { SELECT: true, INSERT: ["job_key", "queue_name", "job_type", "status", "max_attempts", "run_after", "tenant_scope", "property_id", "resource_product", "resource_type", "resource_id", "correlation_id", "idempotency_key_hash", "payload", "job_metadata"], UPDATE: ["job_key", "status", "run_after", "finished_at", "locked_at", "locked_by", "max_attempts", "attempts_count", "updated_at", "job_metadata"] },
  "platform.job_attempts": { SELECT: true, INSERT: ["job_id", "attempt_number", "status", "worker_id", "started_at"], UPDATE: ["status", "finished_at", "error_type", "error_message", "retry_after", "error_metadata"] },
  "platform.dead_letter_events": { SELECT: true, INSERT: ["source_kind", "job_id", "job_attempt_id", "tenant_scope", "property_id", "resource_product", "resource_type", "resource_id", "correlation_id", "idempotency_key_hash", "reason_code", "failure_summary", "failure_payload", "created_at"], UPDATE: ["job_attempt_id", "reason_code", "failure_summary", "failure_payload", "recovery_status", "requeued_job_id", "acknowledged_at", "resolved_at", "created_at"] },
  "platform.idempotency_keys": { SELECT: true, INSERT: ["operation_scope", "operation", "key_hash", "request_fingerprint_hash", "status", "tenant_scope", "property_id", "correlation_id", "expires_at"], UPDATE: ["status", "response_status_code", "response_body_hash", "completed_at", "response_resource_product", "response_resource_type", "response_resource_id", "idempotency_metadata"] },
  "platform.product_audit_events": { SELECT: true, INSERT: ["audit_key", "product", "action", "occurred_at", "tenant_scope", "property_id", "actor_type", "target_resource_product", "target_resource_type", "target_resource_id", "job_id", "idempotency_key_id", "correlation_id", "causation_id", "redacted_payload", "private_payload", "audit_metadata", "retention_class", "privacy_scope"] },
};

// pg_policies canonical output from migration 0411, verified on PG16 and PG17.
const POLICY_DIGEST = "0a3142746f5c83f22e8ade0b096ef1f8d45f5912c58a9cdb980c49f9e8f4e67c";
export async function assertFinanceExpenseWorkerBoundary(
  client: Pick<pg.Client, "query">,
  options: { allowMissingGrants?: boolean; propertyId?: string } = {},
): Promise<void> {
  const role = FINANCE_EXPENSE_WORKER_ROLE;
  const fail = (code: string): never => {
    throw new Error(`finance_worker_${code}`);
  };
  const schemas = (
    await client.query("SELECT pg_catalog.current_schemas(true)::pg_catalog.text[] AS path")
  ).rows[0]?.path;
  if (schemas?.[0] !== "pg_catalog") fail("search_path");
  const account = (
    await client.query(
      `SELECT oid, rolcanlogin AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolinherit OR rolbypassrls OR rolreplication) AS safe FROM pg_catalog.pg_roles WHERE rolname=$1`,
      [role],
    )
  ).rows[0];
  if (!account?.safe) fail("role_unsafe");
  const unsafe = await client.query(
    `SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=$1 OR roleid=$1
    UNION ALL SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::pg_catalog.regclass AND refobjid=$1 AND deptype='o'`,
    [account.oid],
  );
  if (unsafe.rowCount) fail("membership_or_owner");
  const settings = await client.query(
    `SELECT 1 FROM pg_catalog.pg_db_role_setting,pg_catalog.unnest(setconfig) setting
     WHERE setrole IN (0,$1) AND setdatabase IN (0,(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()))
       AND setting LIKE 'session_replication_role=%' AND setting<>'session_replication_role=origin'`,
    [account.oid],
  );
  if (
    settings.rowCount ||
    (await client.query("SHOW session_replication_role")).rows[0].session_replication_role !==
      "origin"
  )
    fail("trigger_bypass");
  const ddl = await client.query(
    `SELECT 1 WHERE pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'CREATE') OR pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'TEMP')
    UNION ALL SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege($1,oid,'CREATE')
    UNION ALL SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prosecdef AND pg_catalog.has_function_privilege($1,p.oid,'EXECUTE')
    UNION ALL SELECT 1 FROM pg_catalog.pg_parameter_acl WHERE pg_catalog.has_parameter_privilege($1,parname,'SET') OR pg_catalog.has_parameter_privilege($1,parname,'ALTER SYSTEM')
    UNION ALL SELECT 1 FROM pg_catalog.pg_class WHERE relkind='S' AND (pg_catalog.has_sequence_privilege($1,oid,'USAGE') OR pg_catalog.has_sequence_privilege($1,oid,'SELECT') OR pg_catalog.has_sequence_privilege($1,oid,'UPDATE'))`,
    [role],
  );
  if (ddl.rowCount) fail("ddl_function_or_sequence");
  const policyRows = (
    await client.query(
      `SELECT schemaname,tablename,policyname,permissive,roles::pg_catalog.text,cmd,qual,with_check FROM pg_catalog.pg_policies WHERE policyname LIKE 'finance_expense_worker_%' ORDER BY schemaname,tablename,policyname`,
    )
  ).rows;
  if (createHash("sha256").update(JSON.stringify(policyRows)).digest("hex") !== POLICY_DIGEST)
    fail("policy_drift");
  const helper = (
    await client.query(
      `SELECT pg_catalog.pg_get_functiondef(p.oid) AS definition, p.proowner=c.relowner AS owner_matches, pg_catalog.has_function_privilege($1,p.oid,'EXECUTE') AS executable FROM pg_catalog.pg_proc p CROSS JOIN pg_catalog.pg_class c WHERE p.oid=pg_catalog.to_regprocedure('platform.finance_expense_worker_scope(pg_catalog.text,pg_catalog.text,pg_catalog.uuid)') AND c.oid='platform.finance_expense_worker_properties'::pg_catalog.regclass`,
      [role],
    )
  ).rows[0];
  if (
    !helper?.owner_matches ||
    !helper.executable ||
    createHash("sha256").update(helper.definition).digest("hex") !==
      "b5cf59790a944e8590f8f790cf1438f904c11de83bdf9a69c5d84c123efc2b85"
  )
    fail("helper_drift");
  const pricingViews = (
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS name,c.relkind,c.reloptions::pg_catalog.text AS options,pg_catalog.pg_get_viewdef(c.oid) AS definition
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname||'.'||c.relname=ANY($1::pg_catalog.text[]) ORDER BY name`,
      [[...pricingScopeViews]],
    )
  ).rows;
  if (
    createHash("sha256").update(JSON.stringify(pricingViews)).digest("hex") !==
    PRICING_SCOPE_VIEW_DIGEST
  )
    fail("pricing_view_drift");
  const pricingScope = (
    await client.query(
      `SELECT c.relkind='r' AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid)
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint p WHERE p.conrelid=c.oid
          AND p.conname='pricing_runtime_property_scopes_database_login_check'
          AND p.contype='c' AND p.convalidated AND NOT p.connoinherit
          AND pg_catalog.pg_get_constraintdef(p.oid)=$1) AS safe
       FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('platform.pricing_runtime_property_scopes')`,
      [PRICING_LOGIN_CHECK],
    )
  ).rows[0];
  if (!pricingScope?.safe) fail("pricing_login_scope_drift");
  const relations = (
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS name,c.oid,c.relrowsecurity AS rls FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`,
    )
  ).rows;
  const version = Number(
    (await client.query("SHOW server_version_num")).rows[0].server_version_num,
  );
  const kinds = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    ...(version >= 170000 ? ["MAINTAIN"] : []),
  ];
  const tableGrants = (
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS name,privilege,pg_catalog.has_table_privilege($1,c.oid,privilege||' WITH GRANT OPTION') AS delegate FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_catalog.unnest($2::pg_catalog.text[]) privilege WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND pg_catalog.has_schema_privilege($1,n.oid,'USAGE') AND pg_catalog.has_table_privilege($1,c.oid,privilege)`,
      [role, kinds],
    )
  ).rows;
  for (const row of tableGrants)
    if (
      row.delegate ||
      (financeExpenseWorkerPrivileges[row.name]?.[row.privilege] !== true &&
        !(row.privilege === "SELECT" && pricingScopeViews.has(row.name)))
    )
      fail("table_privileges");
  const columnGrants = (
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS name,a.attname,privilege,pg_catalog.has_column_privilege($1,c.oid,a.attname,privilege||' WITH GRANT OPTION') AS delegate FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND pg_catalog.has_schema_privilege($1,n.oid,'USAGE') AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege($1,c.oid,a.attname,privilege)`,
      [role],
    )
  ).rows;
  for (const row of columnGrants) {
    const grant = financeExpenseWorkerPrivileges[row.name]?.[row.privilege];
    if (
      row.delegate ||
      !(
        grant === true ||
        (Array.isArray(grant) && grant.includes(row.attname)) ||
        (row.privilege === "SELECT" && pricingScopeViews.has(row.name))
      )
    )
      fail("column_privileges");
  }
  for (const [name, privileges] of Object.entries(financeExpenseWorkerPrivileges)) {
    if (
      name !== "platform.finance_expense_worker_properties" &&
      !relations.find((row) => row.name === name)?.rls
    )
      fail("rls_disabled");
    if (options.allowMissingGrants) continue;
    for (const [privilege, columns] of Object.entries(privileges)) {
      if (
        columns === true
          ? !tableGrants.some((row) => row.name === name && row.privilege === privilege)
          : columns.some(
              (column) =>
                !columnGrants.some(
                  (row) =>
                    row.name === name && row.privilege === privilege && row.attname === column,
                ),
            )
      )
        fail("grant_missing");
    }
  }
  for (const name of Object.keys(financeExpenseWorkerPrivileges))
    if (!relations.some((row) => row.name === name)) fail("relation_missing");
  if (!options.allowMissingGrants) {
    const schemas = [
      ...new Set(Object.keys(financeExpenseWorkerPrivileges).map((name) => name.split(".")[0])),
    ];
    const access = (
      await client.query(
        "SELECT pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'CONNECT') AND pg_catalog.bool_and(pg_catalog.has_schema_privilege($1,name,'USAGE')) AS ok FROM pg_catalog.unnest($2::pg_catalog.text[]) name",
        [role, schemas],
      )
    ).rows[0];
    if (!access?.ok) fail("access_missing");
  }
  if (options.propertyId) {
    const rows = (
      await client.query(
        "SELECT property_id::pg_catalog.text FROM platform.finance_expense_worker_properties",
      )
    ).rows;
    if (rows.length !== 1 || rows[0].property_id !== options.propertyId)
      fail("property_scope_mismatch");
  }
}
