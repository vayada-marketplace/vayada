import { createHash } from "node:crypto";
import type pg from "pg";
import {
  CHANNEX_MANAGEMENT_WORKER_ROLE,
  channexManagementWorkerPrivileges,
} from "./channexManagementWorkerPrivileges.js";

// Canonical catalogs through migration 0410, checked on PG16 and PG17.
const POLICY_DIGEST = "fc60ee7cf0ac6346843a77b8c62b9997eda39af3aa420cd06b732d775e0bd863";
export const channexManagementWorkerFunctions = [
  "platform.channex_management_worker_scope(text,text,uuid)",
  "platform.channex_management_worker_source(text,text,uuid)",
  "platform.tenant_scope_key(text,uuid,uuid)",
  "platform.valid_tenant_scope(text,uuid,uuid)",
  "pms.claim_channex_external_rate(uuid,text,text,uuid,jsonb)",
  "pms.enqueue_restriction_ari(uuid,text)",
] as const;
export async function assertChannexManagementWorkerBoundary(
  client: Pick<pg.Client, "query">,
  options: { allowMissingGrants?: boolean; propertyId?: string } = {},
): Promise<void> {
  const role = CHANNEX_MANAGEMENT_WORKER_ROLE;
  const fail = (code: string): never => {
    throw new Error(`channex_worker_${code}`);
  };
  const account = (
    await client.query(
      `SELECT oid, rolcanlogin AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolinherit OR rolbypassrls OR rolreplication) AS safe FROM pg_roles WHERE rolname=$1`,
      [role],
    )
  ).rows[0];
  if (!account?.safe) fail("role_unsafe");
  const unsafe = await client.query(
    `SELECT 1 FROM pg_auth_members WHERE member=$1 OR roleid=$1
    UNION ALL SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o'`,
    [account.oid],
  );
  if (unsafe.rowCount) fail("membership_or_owner");
  const settings = await client.query(
    `SELECT 1 FROM pg_db_role_setting,unnest(setconfig) setting
    WHERE setrole IN (0,$1) AND setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
      AND setting LIKE 'session_replication_role=%' AND setting<>'session_replication_role=origin'`,
    [account.oid],
  );
  if (
    settings.rowCount ||
    (await client.query("SHOW session_replication_role")).rows[0].session_replication_role !==
      "origin"
  )
    fail("trigger_bypass");
  const functions = await client.query(
    `WITH required(name) AS (SELECT unnest($2::text[])), resolved AS (
       SELECT required.name,to_regprocedure(required.name) AS oid FROM required)
     SELECT resolved.name,resolved.oid IS NOT NULL AS exists,
       EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
         aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
         WHERE p.oid=resolved.oid AND acl.grantee=$1 AND acl.privilege_type='EXECUTE') AS direct,
       EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
         aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
         WHERE p.oid=resolved.oid AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
     FROM resolved`,
    [account.oid, channexManagementWorkerFunctions],
  );
  if (functions.rows.some((row) => !row.exists || !row.direct || row.public))
    fail("function_access_missing");
  const ddl = await client.query(
    `SELECT 1 WHERE has_database_privilege($1,current_database(),'CREATE') OR has_database_privilege($1,current_database(),'TEMP')
    UNION ALL SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND has_schema_privilege($1,oid,'CREATE')
    UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE')
    UNION ALL SELECT 1 FROM pg_parameter_acl WHERE has_parameter_privilege($1,parname,'SET') OR has_parameter_privilege($1,parname,'ALTER SYSTEM')
    UNION ALL SELECT 1 FROM pg_class WHERE relkind='S' AND (has_sequence_privilege($1,oid,'USAGE') OR has_sequence_privilege($1,oid,'SELECT') OR has_sequence_privilege($1,oid,'UPDATE'))`,
    [role],
  );
  if (ddl.rowCount) fail("ddl_function_or_sequence");
  const policyRows = (
    await client.query(
      `SELECT schemaname,tablename,policyname,permissive,roles::text,cmd,qual,with_check FROM pg_policies WHERE policyname LIKE 'channex_management_worker_%' ORDER BY schemaname,tablename,policyname`,
    )
  ).rows;
  if (createHash("sha256").update(JSON.stringify(policyRows)).digest("hex") !== POLICY_DIGEST)
    fail("policy_drift");
  const relations = (
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS name,c.oid,c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`,
    )
  ).rows;
  for (const name of Object.keys(channexManagementWorkerPrivileges))
    if (!relations.some((row) => row.name === name)) fail("relation_missing");
  const catalog = (
    await client.query(channexWorkerCatalogSql, [Object.keys(channexManagementWorkerPrivileges)])
  ).rows;
  if (
    createHash("sha256").update(JSON.stringify(catalog)).digest("hex") !==
    "02b1b63a40dfc267b93931cde591bfb11aa85b76b96c4ae125aa306fc2285e7b"
  )
    fail("catalog_drift");
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
      `SELECT n.nspname||'.'||c.relname AS name,privilege,has_table_privilege($1,c.oid,privilege||' WITH GRANT OPTION') AS delegate FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($2::text[]) privilege WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_table_privilege($1,c.oid,privilege)`,
      [role, kinds],
    )
  ).rows;
  for (const row of tableGrants)
    if (row.delegate || channexManagementWorkerPrivileges[row.name]?.[row.privilege] !== true)
      fail("table_privileges");
  const columnGrants = (
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS name,a.attname,privilege,has_column_privilege($1,c.oid,a.attname,privilege||' WITH GRANT OPTION') AS delegate FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege($1,c.oid,a.attname,privilege)`,
      [role],
    )
  ).rows;
  for (const row of columnGrants) {
    const grant = channexManagementWorkerPrivileges[row.name]?.[row.privilege];
    if (row.delegate || !(grant === true || (Array.isArray(grant) && grant.includes(row.attname))))
      fail("column_privileges");
  }
  for (const [name, privileges] of Object.entries(channexManagementWorkerPrivileges)) {
    if (
      name !== "platform.channex_management_worker_properties" &&
      name !== "finance.online_card_readiness" &&
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
  if (!options.allowMissingGrants) {
    const schemas = [
      ...new Set(Object.keys(channexManagementWorkerPrivileges).map((name) => name.split(".")[0])),
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
      await client.query(
        "SELECT property_id::text FROM platform.channex_management_worker_properties",
      )
    ).rows;
    if (rows.length !== 1 || rows[0].property_id !== options.propertyId)
      fail("property_scope_mismatch");
  }
}

// Attest transitive invoker functions, enabled triggers and the invoker view as
// well as policies. A matching grant list alone must not accept a disabled guard.
export const channexWorkerCatalogSql = `
WITH relations AS (SELECT oid FROM pg_class WHERE oid=ANY($1::regclass[])),
functions AS (
  SELECT tgfoid AS oid FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM relations) AND NOT tgisinternal
  UNION SELECT unnest(ARRAY[
    'platform.channex_management_worker_scope(text,text,uuid)'::regprocedure,
    'platform.channex_management_worker_source(text,text,uuid)'::regprocedure,
    'platform.tenant_scope_key(text,uuid,uuid)'::regprocedure,
    'platform.valid_tenant_scope(text,uuid,uuid)'::regprocedure,
    'pms.claim_channex_external_rate(uuid,text,text,uuid,jsonb)'::regprocedure,
    'pms.enqueue_restriction_ari(uuid,text)'::regprocedure
  ])::oid
)
SELECT 'function:'||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS name,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid IN (SELECT oid FROM functions)
UNION ALL
SELECT 'trigger:'||n.nspname||'.'||c.relname||'.'||t.tgname,
  t.tgenabled::text||':'||pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE t.tgrelid IN (SELECT oid FROM relations) AND NOT t.tgisinternal
UNION ALL
SELECT 'view:finance.online_card_readiness',reloptions::text||':'||pg_get_viewdef(oid)
FROM pg_class WHERE oid='finance.online_card_readiness'::regclass
ORDER BY name`;
