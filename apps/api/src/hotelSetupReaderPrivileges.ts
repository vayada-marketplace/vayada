import type pg from "pg";

// Canonical backend-auth/authorization, registry selection and Feature Hub reads only.
export const HOTEL_SETUP_READER_READ_COLUMNS: Record<string, readonly string[]> = {
  "identity.external_identities": ["provider", "provider_user_id", "user_id"],
  "identity.users": [
    "id",
    "email",
    "name",
    "phone",
    "profile_picture_url",
    "profile_picture_media_object_id",
    "status",
  ],
  "identity.organizations": ["id", "name", "workos_org_id", "kind", "status"],
  "identity.organization_memberships": [
    "id",
    "user_id",
    "organization_id",
    "status",
    "role_key",
    "workos_membership_id",
    "workos_role_slugs",
    "property_access_mode",
    "access_origin",
    "permission_overrides",
    "pms_access_enabled",
    "booking_access_enabled",
    "role_definition_id",
  ],
  "identity.organization_roles": [
    "id",
    "organization_id",
    "security_class",
    "base_role_key",
    "preset_key",
    "default_permissions",
  ],
  "identity.organization_resource_links": [
    "organization_id",
    "product",
    "resource_type",
    "resource_id",
    "relationship",
    "status",
  ],
  "identity.membership_property_assignments": ["membership_id", "property_id"],
  "identity.role_permission_grants": ["organization_kind", "role_key", "permission_key"],
  "identity.product_entitlements": [
    "organization_id",
    "product",
    "entitlement_key",
    "status",
    "resource_product",
    "resource_type",
    "resource_id",
    "starts_at",
    "expires_at",
    "updated_at",
    "metadata",
  ],
  "platform.hotel_setup_property_scopes": [
    "database_login",
    "property_id",
    "organization_id",
    "operation_class",
    "active",
  ],
  "platform.product_audit_events": ["product", "audit_key"],
};
export const HOTEL_SETUP_READER_AUDIT_COLUMNS = [
  "audit_key",
  "product",
  "action",
  "occurred_at",
  "tenant_scope",
  "organization_id",
  "actor_type",
  "actor_user_id",
  "target_resource_product",
  "target_resource_type",
  "target_resource_id",
  "correlation_id",
  "redacted_payload",
  "audit_metadata",
  "retention_class",
  "privacy_scope",
];
const schemas = `n.nspname NOT IN ('pg_catalog','information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'`;

/** Read-only catalog check. Audit row-shape/RLS, IAM and native command ACLs are separate gates. */
export async function assertHotelSetupReaderPrivileges(client: Pick<pg.Pool, "query">) {
  const version = await client.query<{ version: number }>(
    "SELECT pg_catalog.current_setting('server_version_num')::integer AS version",
  );
  const maintain = (version.rows[0]?.version ?? 0) >= 170000 ? ",MAINTAIN" : "";
  const columns = await client.query<{ relation: string; column: string; privilege: string }>(`
    SELECT n.nspname || '.' || c.relname AS relation, a.attname AS "column",
      privileges.privilege FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) privileges(privilege)
    WHERE ${schemas} AND c.relkind IN ('r','p','v','m','f')
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
      AND pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,privileges.privilege)`);
  const expected = new Set(
    Object.entries(HOTEL_SETUP_READER_READ_COLUMNS).flatMap(([relation, names]) =>
      names.map((column) => `${relation}:${column}:SELECT`),
    ),
  );
  for (const column of HOTEL_SETUP_READER_AUDIT_COLUMNS)
    expected.add(`platform.product_audit_events:${column}:INSERT`);
  const actual = new Set(
    columns.rows.map((row) => `${row.relation}:${row.column}:${row.privilege}`),
  );
  if (expected.size !== actual.size || [...expected].some((key) => !actual.has(key)))
    throw new Error("Hotel setup reader column privileges mismatch");

  const forbidden = await client.query<{ unsafe: boolean }>(
    `SELECT (
    EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE ${schemas}
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE'))
    OR pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE ${schemas} AND c.relkind IN ('r','p','v','m','f')
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
      AND (pg_catalog.has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER${maintain}')
        OR (n.nspname || '.' || c.relname <> 'platform.product_audit_events'
          AND pg_catalog.has_table_privilege(current_user,c.oid,'INSERT'))
        OR (NOT (n.nspname || '.' || c.relname = ANY($1::text[]))
          AND pg_catalog.has_table_privilege(current_user,c.oid,'SELECT'))))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE ${schemas} AND c.relkind='S'
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
      AND pg_catalog.has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE ${schemas} AND p.prosecdef
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
      AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE'))
  ) AS unsafe`,
    [Object.keys(HOTEL_SETUP_READER_READ_COLUMNS)],
  );
  if (forbidden.rows.length !== 1 || forbidden.rows[0]?.unsafe !== false)
    throw new Error("Hotel setup reader unsafe capabilities");
}
