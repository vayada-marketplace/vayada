import { createHash } from "node:crypto";
import type pg from "pg";

export const FINANCE_EXPORT_WORKER_ROLE = "vayada_next_finance_export_worker";

// Exact effective-grant contract. Column lists intentionally deny receipt data.
// prettier-ignore
export const financeExportWorkerPrivileges: Record<string, Record<string, true | string[]>> = {
  "platform.finance_export_worker_properties": { SELECT: ["property_id"] },
  "hotel_catalog.properties": { SELECT: ["id", "profile_revision", "updated_at"] },
  "hotel_catalog.property_locations": { SELECT: ["property_id", "timezone", "updated_at"] },
  "pms.property_pricing_settings": { SELECT: ["property_id", "currency", "pricing_currency_revision", "created_at", "updated_at"] },
  "finance.expenses": { SELECT: ["id", "property_id", "category_id", "origin", "incurred_on", "paid_on", "vendor", "amount", "currency", "payment_status", "recurring_rule_id", "source_key", "reverses_expense_id", "supplier_invoice_number", "revision", "updated_at"] },
  "finance.folios": { SELECT: ["id", "property_id", "guest_booking_id"] },
  "finance.folio_revisions": { SELECT: ["id", "folio_id", "property_id", "revision", "state", "service_from", "service_to", "total_amount", "currency", "created_at", "recipient_snapshot_ciphertext", "recipient_encryption_scheme", "recipient_key_version", "source_digest", "source_freshness"] },
  "finance.folio_lines": { SELECT: ["id", "folio_revision_id", "position", "kind", "description", "quantity", "unit_amount", "line_total", "service_on", "source_type", "source_id", "source_revision"] },
  "finance.folio_payment_references": { SELECT: ["folio_revision_id", "position", "payment_id", "amount"] },
  "platform.jobs": { SELECT: ["id", "queue_name", "job_type", "status", "tenant_scope", "property_id", "resource_type", "resource_id", "correlation_id", "idempotency_key_hash", "attempts_count", "max_attempts", "run_after", "locked_at", "locked_by", "priority", "created_at", "payload", "job_metadata"], UPDATE: ["status", "attempts_count", "run_after", "finished_at", "locked_at", "locked_by", "updated_at", "job_metadata"] },
  "platform.job_attempts": { SELECT: ["id", "job_id", "attempt_number", "status"], INSERT: ["job_id", "attempt_number", "status", "worker_id", "started_at"], UPDATE: ["status", "finished_at", "error_type", "error_message", "retry_after", "error_metadata"] },
  "platform.dead_letter_events": { INSERT: ["source_kind", "job_id", "job_attempt_id", "tenant_scope", "property_id", "resource_product", "resource_type", "resource_id", "correlation_id", "idempotency_key_hash", "reason_code", "failure_summary", "failure_payload", "created_at"] },
  "platform.product_audit_events": { INSERT: ["audit_key", "product", "action", "occurred_at", "tenant_scope", "property_id", "actor_type", "target_resource_product", "target_resource_type", "target_resource_id", "job_id", "correlation_id", "causation_id", "redacted_payload", "audit_metadata", "retention_class", "privacy_scope"] },
  "platform.media_objects": { SELECT: ["id", "bucket", "storage_key", "purpose", "source_system", "source_table", "source_row_id", "retained_until", "lifecycle_status", "updated_at"], INSERT: ["id", "bucket", "storage_key", "visibility", "purpose", "owner_organization_id", "property_id", "resource_product", "resource_type", "resource_id", "lifecycle_status", "content_type", "original_filename", "source_system", "source_table", "source_row_id", "retained_until", "created_by_user_id", "created_at", "updated_at"], UPDATE: ["lifecycle_status", "size_bytes", "checksum_sha256", "updated_at"] },
};

// Canonical pg_policies output from migration 0412 on PostgreSQL 16 and 17.
const POLICY_DIGEST = "aed0e239166590e605f7b7621744bdac2a2ca535ecca5335234971fe65c54d9a";
const HELPER_DIGEST = "50b550dff92f229444ddbd870d1994581477768d41b389754d24bcd786ae7490";

export async function assertFinanceExportWorkerBoundary(
  client: Pick<pg.Client, "query">,
  options: { allowMissingGrants?: boolean; propertyId?: string } = {},
): Promise<void> {
  const role = FINANCE_EXPORT_WORKER_ROLE;
  const fail = (code: string): never => {
    throw new Error(`finance_export_worker_${code}`);
  };
  const account = (
    await client.query(
      `SELECT oid,rolcanlogin AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolinherit OR rolbypassrls OR rolreplication) AS safe FROM pg_roles WHERE rolname=$1`,
      [role],
    )
  ).rows[0];
  if (!account?.safe) fail("role_unsafe");
  if (
    (
      await client.query(
        `SELECT 1 FROM pg_auth_members WHERE member=$1 OR roleid=$1
         UNION ALL SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o'`,
        [account.oid],
      )
    ).rowCount
  )
    fail("membership_or_owner");
  if (
    (
      await client.query(
        `SELECT 1 WHERE has_database_privilege($1,current_database(),'CREATE') OR has_database_privilege($1,current_database(),'TEMP')
         UNION ALL SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND has_schema_privilege($1,oid,'CREATE')
         UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE')
         UNION ALL SELECT 1 FROM pg_class WHERE relkind='S' AND (has_sequence_privilege($1,oid,'USAGE') OR has_sequence_privilege($1,oid,'SELECT') OR has_sequence_privilege($1,oid,'UPDATE'))`,
        [role],
      )
    ).rowCount
  )
    fail("ddl_function_or_sequence");
  const policies = (
    await client.query(
      `SELECT schemaname,tablename,policyname,permissive,roles::text,cmd,qual,with_check FROM pg_policies WHERE policyname='finance_export_worker_scope' ORDER BY schemaname,tablename,policyname`,
    )
  ).rows;
  if (digest(policies) !== POLICY_DIGEST) fail("policy_drift");
  const helper = (
    await client.query(
      `SELECT pg_get_functiondef(p.oid) AS definition,p.proowner=c.relowner AS owner_matches,has_function_privilege($1,p.oid,'EXECUTE') AS executable FROM pg_proc p CROSS JOIN pg_class c WHERE p.oid=to_regprocedure('platform.finance_export_worker_scope(text,text,uuid)') AND c.oid='platform.finance_export_worker_properties'::regclass`,
      [role],
    )
  ).rows[0];
  if (!helper?.owner_matches || !helper.executable || digest(helper.definition) !== HELPER_DIGEST)
    fail("helper_drift");

  const relations = (
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS name,c.oid,c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`,
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
      `SELECT n.nspname||'.'||c.relname AS name,privilege,has_table_privilege($1,c.oid,privilege||' WITH GRANT OPTION') AS delegate FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($2::text[]) privilege WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege($1,n.oid,'USAGE') AND has_table_privilege($1,c.oid,privilege)`,
      [role, kinds],
    )
  ).rows;
  for (const row of tableGrants)
    if (row.delegate || financeExportWorkerPrivileges[row.name]?.[row.privilege] !== true)
      fail("table_privileges");
  const columnGrants = (
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS name,a.attname,privilege,has_column_privilege($1,c.oid,a.attname,privilege||' WITH GRANT OPTION') AS delegate FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege($1,n.oid,'USAGE') AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege($1,c.oid,a.attname,privilege)`,
      [role],
    )
  ).rows;
  for (const row of columnGrants) {
    const grant = financeExportWorkerPrivileges[row.name]?.[row.privilege];
    if (row.delegate || !(grant === true || (Array.isArray(grant) && grant.includes(row.attname))))
      fail("column_privileges");
  }
  for (const [name, privileges] of Object.entries(financeExportWorkerPrivileges)) {
    if (
      name !== "platform.finance_export_worker_properties" &&
      !name.startsWith("booking.pricing_runtime_effective_") &&
      !relations.find((row) => row.name === name)?.rls
    )
      fail("rls_disabled");
    if (options.allowMissingGrants) continue;
    for (const [privilege, columns] of Object.entries(privileges)) {
      const present =
        columns === true
          ? tableGrants.some((row) => row.name === name && row.privilege === privilege)
          : columns.every((column) =>
              columnGrants.some(
                (row) => row.name === name && row.privilege === privilege && row.attname === column,
              ),
            );
      if (!present) fail("grant_missing");
    }
  }
  for (const name of Object.keys(financeExportWorkerPrivileges))
    if (!relations.some((row) => row.name === name)) fail("relation_missing");
  if (!options.allowMissingGrants) {
    const schemas = [
      ...new Set(Object.keys(financeExportWorkerPrivileges).map((name) => name.split(".")[0])),
    ];
    const access = (
      await client.query(
        "SELECT has_database_privilege($1,current_database(),'CONNECT') AND bool_and(has_schema_privilege($1,name,'USAGE')) AS ok FROM unnest($2::text[]) name",
        [role, schemas],
      )
    ).rows[0];
    if (!access?.ok) fail("access_missing");
  }
  if (options.propertyId) {
    const rows = (
      await client.query("SELECT property_id::text FROM platform.finance_export_worker_properties")
    ).rows;
    if (rows.length !== 1 || rows[0].property_id !== options.propertyId)
      fail("property_scope_mismatch");
  }
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
