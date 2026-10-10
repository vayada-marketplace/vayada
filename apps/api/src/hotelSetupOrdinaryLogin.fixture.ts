import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Test-only login shaped like the production API role `vayada_next_api_runtime` in the
 * VAY-2054 product-DML posture (engineering/api-runtime-database-role.md). The lists below
 * mirror platform `scripts/grant-target-database-runtime-product-dml.mjs` on main as of
 * 2026-10-07 (#454 merged); update both together, notably when VAY-2057 slice 0.3 edits the
 * protected list. listOrdinaryPostureViolations re-runs the preflight's own posture queries. Production additionally keeps legacy
 * SELECT grants on identity tables, which the fixture reproduces with schema-wide SELECT.
 * No default privileges are set: the fixture is applied after migrations.
 */
const SCHEMAS = [
  "hotel_catalog",
  "booking",
  "pms",
  "marketplace",
  "distribution",
  "finance",
  "platform",
];
const RECEIPT = "platform.legacy_owner_bootstrap_receipts";
const NO_READ = [
  "platform.identity_migration_provenance",
  "platform.legacy_historical_binding_transitions",
  "platform.finance_expense_worker_properties",
  "platform.finance_export_worker_properties",
  "marketplace.affiliate_click_quota_windows",
  "pms.inventory_coverage_validation_queue",
];
const NO_READ_PATTERNS = [
  /^platform\.(identity_migration_|legacy_historical_binding_)/,
  /^platform\.finance_.*_worker_properties$/,
];
const NO_WRITE = [
  "platform.schema_migrations",
  "platform.pricing_runtime_property_scopes",
  "platform.channex_management_worker_properties",
  "platform.legacy_owner_approval_records",
  "platform.legacy_owner_approval_revocations",
  "booking.pricing_runtime_effective_property_scopes",
  "marketplace.affiliate_click_occurrences",
  "booking.affiliate_click_contexts",
  "booking.affiliate_click_admissions",
  "booking.affiliate_original_booking_bindings",
  "finance.expense_generation_dispatches",
  "pms.channex_room_availability_attempts",
  "pms.channex_room_availability_receipts",
  "pms.channex_room_availability_reconciliation_attestations",
  "pms.channex_ari_schedule_sources",
  "pms.channel_sync_status",
  "booking.affiliate_referral_production_preflight_revocations",
];
const NO_WRITE_PATTERNS = [
  /^platform\.(production_|source_extraction_|legacy_|channex_adoption_|identity_migration_)/,
  /^pms\.channex_room_availability_/,
  /^pms\.channex_ari_schedule_/,
  /^(marketplace|booking)\.affiliate_click_/,
  /^finance\.expense_generation_/,
];
const APPEND_ONLY = [
  "platform.product_audit_events",
  "platform.domain_events",
  "booking.addon_revenue_evidence",
  "pms.channex_offer_ari_receipts",
  "pms.channex_offer_create_receipts",
  "pms.channex_offer_target_versions",
  "finance.commission_rate_changes",
  "distribution.external_api_usage_events",
  "finance.affiliate_percentage_policy_approvals",
  "booking.pricing_quotes",
];
const NO_DELETE = ["hotel_catalog.properties"];
const RUNTIME_EXECUTABLE_FUNCTIONS = [
  "pms.enqueue_restriction_ari(uuid,text)",
  "pms.claim_channex_external_rate(uuid,text,text,uuid,jsonb)",
];
const IDENTITY_LOCK_ONLY = [
  "identity.organizations",
  "identity.users",
  "identity.organization_memberships",
  "identity.role_permission_grants",
  "identity.membership_property_assignments",
  "identity.organization_roles",
];
const PRODUCT_IDENTITY_COLUMNS: Record<string, Record<"INSERT" | "UPDATE", string[]>> = {
  "identity.product_entitlements": {
    INSERT: [
      "organization_id",
      "product",
      "entitlement_key",
      "status",
      "starts_at",
      "expires_at",
      "metadata",
      "resource_product",
      "resource_type",
      "resource_id",
    ],
    UPDATE: ["status", "starts_at", "expires_at", "updated_at", "metadata"],
  },
  "identity.organization_resource_links": {
    INSERT: [
      "organization_id",
      "product",
      "resource_type",
      "resource_id",
      "relationship",
      "status",
    ],
    UPDATE: ["id", "status", "updated_at"],
  },
};
const DESTRUCTIVE = "INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER";

type Queryable = Pick<pg.Client, "query">;

const ident = (relation: string) =>
  relation
    .split(".")
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(".");
const matches = (name: string, list: string[], patterns: RegExp[]) =>
  list.includes(name) || patterns.some((pattern) => pattern.test(name));

async function columnsOf(admin: Queryable, relation: string): Promise<string[]> {
  const result = await admin.query<{ attname: string }>(
    "SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped",
    [relation],
  );
  return result.rows.map((row) => `"${row.attname.replaceAll('"', '""')}"`);
}

async function revokeAllColumns(
  admin: Queryable,
  relation: string,
  privileges: string,
  login: string,
) {
  const columns = await columnsOf(admin, relation);
  if (columns.length)
    await admin.query(
      `REVOKE ${privileges} (${columns.join(",")}) ON ${ident(relation)} FROM ${login}`,
    );
}

export type HotelSetupOrdinaryLoginFixture = {
  login: string;
  connectionString: string;
  /** Drops the login; end every pool that used it first. */
  drop(): Promise<void>;
};

/** Creates the login and applies the mirrored product-DML grant set on an already migrated database. */
export async function createHotelSetupOrdinaryLoginFixture(
  admin: Queryable,
  databaseUrl: string,
): Promise<HotelSetupOrdinaryLoginFixture> {
  const login = `vayada_test_api_runtime_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const password = randomUUID();
  await admin.query(
    `CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  );
  for (const schema of SCHEMAS) {
    await admin.query(`GRANT USAGE ON SCHEMA ${ident(schema)} TO ${login}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ident(schema)} TO ${login}`,
    );
    await admin.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${ident(schema)} TO ${login}`,
    );
  }
  const product = await admin.query<{ name: string }>(
    `SELECT namespace.nspname || '.' || relation.relname AS name
     FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE namespace.nspname=ANY($1::text[]) AND relation.relkind IN ('r','p','v','m','f') ORDER BY 1`,
    [SCHEMAS],
  );
  const present = new Set(product.rows.map((row) => row.name));
  for (const { name } of product.rows) {
    if (matches(name, NO_READ, NO_READ_PATTERNS) || name === RECEIPT) {
      await admin.query(`REVOKE ALL ON ${ident(name)} FROM ${login}`);
      await revokeAllColumns(admin, name, "ALL", login);
    } else if (matches(name, NO_WRITE, NO_WRITE_PATTERNS)) {
      await admin.query(`REVOKE ${DESTRUCTIVE} ON ${ident(name)} FROM ${login}`);
      await revokeAllColumns(admin, name, "INSERT, UPDATE, REFERENCES", login);
    }
  }
  if (present.has(RECEIPT))
    await admin.query(`GRANT SELECT (owner_user_ids) ON ${ident(RECEIPT)} TO ${login}`);
  for (const name of APPEND_ONLY.filter((name) => present.has(name))) {
    await admin.query(`REVOKE UPDATE, DELETE ON ${ident(name)} FROM ${login}`);
    await revokeAllColumns(admin, name, "UPDATE", login);
  }
  for (const name of NO_DELETE.filter((name) => present.has(name)))
    await admin.query(`REVOKE DELETE ON ${ident(name)} FROM ${login}`);
  await admin.query(`GRANT USAGE ON SCHEMA identity TO ${login}`);
  // Production keeps legacy identity reads; the lock column is the only identity UPDATE outside the matrix.
  await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA identity TO ${login}`);
  for (const name of IDENTITY_LOCK_ONLY)
    await admin.query(`GRANT UPDATE (created_at) ON ${ident(name)} TO ${login}`);
  for (const [name, grants] of Object.entries(PRODUCT_IDENTITY_COLUMNS))
    for (const [privilege, columns] of Object.entries(grants))
      await admin.query(`GRANT ${privilege} (${columns.join(", ")}) ON ${ident(name)} TO ${login}`);
  for (const name of RUNTIME_EXECUTABLE_FUNCTIONS)
    await admin.query(`GRANT EXECUTE ON FUNCTION ${name} TO ${login}`);

  const connection = new URL(databaseUrl);
  connection.username = login;
  connection.password = password;
  return {
    login,
    connectionString: connection.toString(),
    async drop() {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()",
        [login],
      );
      await admin.query(`DROP OWNED BY ${login}`);
      await admin.query(`DROP ROLE ${login}`);
    },
  };
}

/** Mirrors the platform preflight: the login may execute no SECURITY DEFINER routine at all. */
export async function listExecutableDefinerFunctions(client: Queryable): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT namespace.nspname || '.' || procedure.proname AS name
     FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
     WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
       AND namespace.nspname NOT LIKE 'pg_toast%' AND namespace.nspname NOT LIKE 'pg_temp_%'
       AND procedure.prosecdef AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
     ORDER BY 1`,
  );
  return result.rows.map((row) => row.name);
}

/** The platform preflight's product-DML posture queries, run as the login: identity writes
 * outside the product-link matrix and the created_at lock column, and readable protected
 * relations. An empty list means the fixture still matches the production posture. */
export async function listOrdinaryPostureViolations(client: Queryable): Promise<string[]> {
  const allowed = {
    ...PRODUCT_IDENTITY_COLUMNS,
    ...Object.fromEntries(IDENTITY_LOCK_ONLY.map((name) => [name, { UPDATE: ["created_at"] }])),
  };
  const identity = await client.query<{ name: string }>(
    `SELECT 'identity.' || relation.relname || '.' || attribute.attname || ':' || privilege.name AS name
       FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privilege(name)
       LEFT JOIN jsonb_each($1::jsonb) AS allowed(relation, privileges) ON allowed.relation = 'identity.' || relation.relname
      WHERE namespace.nspname = 'identity' AND relation.relkind IN ('r','p','v','m','f')
        AND has_column_privilege(current_user, relation.oid, attribute.attname, privilege.name)
        AND NOT coalesce(allowed.privileges -> privilege.name ? attribute.attname, false)
     UNION ALL
     SELECT 'identity.' || relation.relname || ':' || privilege.name
       FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) AS privilege(name)
      WHERE namespace.nspname = 'identity' AND relation.relkind IN ('r','p','v','m','f')
        AND has_table_privilege(current_user, relation.oid, privilege.name)`,
    [JSON.stringify(allowed)],
  );
  const readable = await client.query<{ name: string }>(
    `SELECT namespace.nspname || '.' || relation.relname AS name
       FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[]) AND relation.relkind IN ('r','p','v','m','f')
        AND (has_table_privilege(current_user, relation.oid, 'SELECT')
          OR has_any_column_privilege(current_user, relation.oid, 'SELECT'))`,
    [SCHEMAS],
  );
  return [
    ...identity.rows.map((row) => `identity_write:${row.name}`),
    ...readable.rows
      .filter((row) => matches(row.name, NO_READ, NO_READ_PATTERNS))
      .map((row) => `protected_read:${row.name}`),
  ];
}
