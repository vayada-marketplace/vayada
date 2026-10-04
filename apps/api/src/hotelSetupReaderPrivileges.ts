import type pg from "pg";
import type { HotelSetupCommandMode } from "./hotelSetupCommandServiceConfig.js";

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
    "credential_role_oid",
    "credential_secret_version",
    "credential_ready_at",
  ],
  "platform.product_audit_events": ["product", "audit_key"],
};
export const HOTEL_SETUP_CREATION_READER_READ_COLUMNS = Object.fromEntries(
  Object.entries(HOTEL_SETUP_READER_READ_COLUMNS)
    .filter(([relation]) => relation !== "platform.hotel_setup_property_scopes")
    .concat([
      [
        "platform.hotel_setup_creation_scopes",
        [
          "database_login",
          "organization_id",
          "credential_role_oid",
          "credential_secret_version",
          "credential_ready_at",
        ],
      ],
    ]),
);
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

export type HotelSetupColumnPrivileges = Record<
  string,
  Partial<Record<"SELECT" | "INSERT" | "UPDATE", readonly string[]>>
>;
export type HotelSetupPrivilegeQueryable = {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
};

/** Effective catalog ACLs, including inherited/PUBLIC privileges; no SQL writes. */
export async function assertHotelSetupColumnPrivileges(
  client: HotelSetupPrivilegeQueryable,
  inventory: HotelSetupColumnPrivileges,
  allowedDefiners: readonly string[] = [],
  allowedDeletes: readonly string[] = [],
) {
  const version = await client.query<{ version: number }>(
    "SELECT pg_catalog.current_setting('server_version_num')::integer AS version",
  );
  const maintain = (version.rows[0]?.version ?? 0) >= 170000 ? ",MAINTAIN" : "";
  const columns = await client.query<{
    relation: string;
    column: string;
    privilege: string;
    grantable: boolean;
  }>(`
    SELECT n.nspname || '.' || c.relname AS relation, a.attname AS "column",
      privileges.privilege,
      pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,
        privileges.privilege || ' WITH GRANT OPTION') AS grantable FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) privileges(privilege)
    WHERE ${schemas} AND c.relkind IN ('r','p','v','m','f')
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
      AND pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,privileges.privilege)`);
  const expected = new Set(
    Object.entries(inventory).flatMap(([relation, privileges]) =>
      Object.entries(privileges).flatMap(([privilege, names]) =>
        names.map((column) => `${relation}:${column}:${privilege}`),
      ),
    ),
  );
  const actual = new Set(
    columns.rows.map((row) => `${row.relation}:${row.column}:${row.privilege}`),
  );
  if (
    columns.rows.some((row) => row.grantable) ||
    expected.size !== actual.size ||
    [...expected].some((key) => !actual.has(key))
  )
    throw new Error("Hotel setup credential column privileges mismatch");

  const forbidden = await client.query<{ unsafe: boolean }>(
    `SELECT (
    EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE ${schemas}
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE,USAGE WITH GRANT OPTION'))
    OR pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE ${schemas} AND c.relkind IN ('r','p','v','m','f')
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
      AND (pg_catalog.has_table_privilege(current_user,c.oid,'TRUNCATE,TRIGGER${maintain}')
        OR (pg_catalog.has_table_privilege(current_user,c.oid,'DELETE')
          AND NOT (n.nspname || '.' || c.relname = ANY($4::text[])))
        OR pg_catalog.has_table_privilege(current_user,c.oid,'DELETE WITH GRANT OPTION')
        OR (NOT (n.nspname || '.' || c.relname = ANY($2::text[]))
          AND pg_catalog.has_table_privilege(current_user,c.oid,'INSERT'))
        OR (NOT (n.nspname || '.' || c.relname = ANY($1::text[]))
          AND pg_catalog.has_table_privilege(current_user,c.oid,'SELECT'))))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE ${schemas} AND c.relkind='S'
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
      AND pg_catalog.has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE ${schemas}
      AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
      AND (pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION')
        OR (p.prosecdef AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
          AND NOT (p.oid=ANY($3::regprocedure[])))))
    OR (SELECT count(*) FROM pg_catalog.unnest($4::text[]) relation
      WHERE pg_catalog.has_table_privilege(current_user,relation,'DELETE'))<>pg_catalog.cardinality($4::text[])
  ) AS unsafe`,
    [
      Object.keys(inventory).filter((name) => inventory[name]!.SELECT),
      Object.keys(inventory).filter((name) => inventory[name]!.INSERT),
      allowedDefiners,
      allowedDeletes,
    ],
  );
  if (forbidden.rows.length !== 1 || forbidden.rows[0]?.unsafe !== false)
    throw new Error("Hotel setup credential unsafe capabilities");
}

/** Read-only catalog check. Audit row-shape/RLS, IAM and native command ACLs are separate gates. */
export async function assertHotelSetupReaderPrivileges(
  client: Pick<pg.Pool, "query">,
  mode: HotelSetupCommandMode = "property_commands",
) {
  await assertHotelSetupCredentialReadinessSchema(client);
  const inventory: HotelSetupColumnPrivileges = Object.fromEntries(
    Object.entries(
      mode === "property_creation"
        ? HOTEL_SETUP_CREATION_READER_READ_COLUMNS
        : HOTEL_SETUP_READER_READ_COLUMNS,
    ).map(([relation, SELECT]) => [relation, { SELECT }]),
  );
  inventory["platform.product_audit_events"]!.INSERT = HOTEL_SETUP_READER_AUDIT_COLUMNS;
  await assertHotelSetupColumnPrivileges(client, inventory);
  await assertHotelSetupAuditBoundary(client);
}

/** Startup must deny old, partial or weakened readiness migrations before admission. */
export async function assertHotelSetupCredentialReadinessSchema(
  client: HotelSetupPrivilegeQueryable,
) {
  const expression =
    "(((credential_role_oid IS NULL) AND (credential_secret_version IS NULL) AND (credential_ready_at IS NULL)) OR ((credential_role_oid IS NOT NULL) AND (credential_secret_version IS NOT NULL) AND (credential_secret_version ~ '^[A-Za-z0-9-]{32,64}$'::text) AND (credential_ready_at IS NOT NULL)))";
  const result = await client.query<{ safe: boolean }>(
    `SELECT bool_and(
    (SELECT count(*)=3 FROM pg_catalog.pg_attribute a
      JOIN (VALUES ('credential_role_oid','oid'::regtype),
        ('credential_secret_version','text'::regtype),
        ('credential_ready_at','timestamptz'::regtype)) expected(name,type)
        ON a.attname=expected.name AND a.atttypid=expected.type
      WHERE a.attrelid=scope.relation::regclass AND a.attnum>0 AND NOT a.attisdropped
        AND NOT a.attnotnull AND a.attidentity='' AND a.attgenerated='' AND NOT a.atthasdef)
    AND (SELECT count(*)=1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid=scope.relation::regclass AND c.conname=scope.constraint_name
        AND c.contype='c' AND c.convalidated
        AND pg_catalog.pg_get_expr(c.conbin,c.conrelid)=$1)
    ) AS safe FROM (VALUES
      ('platform.hotel_setup_creation_scopes','hotel_setup_creation_credential_ready'),
      ('platform.hotel_setup_property_scopes','hotel_setup_property_credential_ready')
    ) scope(relation,constraint_name)`,
    [expression],
  );
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true)
    throw new Error("Hotel setup credential readiness schema mismatch");
}

export async function assertHotelSetupAuditBoundary(client: HotelSetupPrivilegeQueryable) {
  // PG16/17 render the reviewed full policy set and audit triggers identically.
  // Pin trigger bodies too: INSERT triggers execute even without function EXECUTE grants.
  const audit = await client.query<{ safe: boolean }>(`SELECT (
    c.relrowsecurity AND (SELECT pg_catalog.md5(pg_catalog.string_agg(
        p.polname || p.polpermissive::text || p.polcmd::text
        || COALESCE((SELECT pg_catalog.string_agg(
          CASE WHEN role=0 THEN 'PUBLIC' ELSE role::regrole::text END,',' ORDER BY role::regrole::text)
          FROM pg_catalog.unnest(p.polroles) roles(role)),'')
        || COALESCE(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'')
        || COALESCE(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),''),'' ORDER BY p.polname))
        ='d1204ec07f6ad630751108c5a4e8e993'
      FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid)
    AND pg_catalog.md5(pg_catalog.pg_get_functiondef(
      'platform.hotel_setup_reader_audit_allowed(platform.product_audit_events)'::regprocedure))
      ='990c9f2f388ba30c768c5b7076c11700'
    AND pg_catalog.has_function_privilege(current_user,
      'platform.hotel_setup_reader_audit_allowed(platform.product_audit_events)','EXECUTE')
    AND (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_catalog.pg_get_triggerdef(t.oid)
      || pg_catalog.pg_get_functiondef(t.tgfoid) || t.tgenabled::text,'' ORDER BY t.tgname))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
      ='c039e04dcdd85a42db5a8f8379a37244'
  ) AS safe FROM pg_catalog.pg_class c WHERE c.oid='platform.product_audit_events'::regclass`);
  if (audit.rows.length !== 1 || audit.rows[0]?.safe !== true)
    throw new Error("Hotel setup reader audit boundary mismatch");
}
