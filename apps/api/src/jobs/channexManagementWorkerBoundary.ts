import { createHash } from "node:crypto";
import type pg from "pg";
import {
  CHANNEX_MANAGEMENT_WORKER_ROLE,
  channexManagementWorkerPrivileges,
  optionalChannexClaimedGrants,
  optionalChannexDeliveryRelations,
} from "./channexManagementWorkerPrivileges.js";

// Worker policy catalog with the VAY-2108 claimed scope (0519), and with the ongoing offer ARI
// delivery scope (0521), both checked on PG16 and PG17. This image lists the 0520 delivery tables
// in its privilege matrix, so it needs 0519 and 0520 (cloud job 6dc8de37 computed both values on
// that base); accepting both lets it start on either side of 0521, so it is released before 0521
// and stays a safe rollback target once 0521 ships. VAY-2108 D7b adds the value after 0522
// (claimed room-type provisioning: jobs shape and mapping insert policy; cloud job 7edc57a2 on
// 0521 + 0522, PG16 = PG17), so this image also starts once 0522 is applied.
const POLICY_DIGESTS = new Set([
  "f9a53a613884875be8387bfb59bf5772038eda202d0f213c32854585d247b7be",
  "4b14279a210c9f240ea9fefbc8c78dd3886dcccd5e42c1f7f67a436fe6685e3a",
  "07ed8b6e9df38dcd14b5bde0dc8a5e162792ce7585d35222fb86ad5809743802",
]);
// Shared trigger catalog over the privilege-matrix relations plus the pinned helpers: with 0519
// and 0520 (the delivery tables' guard triggers are attested through the matrix), and with 0521's
// delivery helper and sales reset trigger. Earlier catalogs are unreachable for this image, which
// refuses a database without the delivery tables (relation_missing).
const CATALOG_DIGESTS = new Set([
  "64b538202053714d7a486cbdfd8940ce55a063db5618e6eef123859f9e0e1139",
  "3ffdd1b6dcb578a87c62bdcc7b04828fbaee45596cfaa1601a73f15f95f294bb",
]);
export const channexManagementWorkerFunctions = [
  "platform.channex_management_worker_scope(text,text,uuid)",
  "platform.channex_management_worker_source(text,text,uuid)",
  "platform.tenant_scope_key(text,uuid,uuid)",
  "platform.valid_tenant_scope(text,uuid,uuid)",
  "pms.claim_channex_external_rate(uuid,text,text,uuid,jsonb)",
  "pms.enqueue_restriction_ari(uuid,text)",
] as const;
// Reads tolerated beyond the privilege map: the pricing scope view, and the claimed scope's owner
// table (VAY-2108, 0519), whose read the claimed grant adds after 0519.
const toleratedReads = new Set([
  "booking.pricing_runtime_effective_property_scopes",
  "platform.channex_management_worker_claimed_operations",
]);
export async function assertChannexManagementWorkerBoundary(
  client: Pick<pg.Client, "query">,
  options: {
    allowMissingGrants?: boolean;
    propertyId?: string;
    connectionScope?: boolean;
    claimedScope?: boolean;
    /** VAY-2108 D3: ongoing offer delivery is on, so the delivery tables must be granted and
     * row-secured (migration D3a plus the platform's delivery grant). Off: they may still be
     * ungranted and without policies. */
    offerDelivery?: boolean;
  } = {},
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
  // The drift codes carry the actual digest, so a re-pin can be read from the failure.
  const policyDigest = createHash("sha256").update(JSON.stringify(policyRows)).digest("hex");
  if (!POLICY_DIGESTS.has(policyDigest)) fail(`policy_drift:${policyDigest}`);
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
  const catalogDigest = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
  if (!CATALOG_DIGESTS.has(catalogDigest)) fail(`catalog_drift:${catalogDigest}`);
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
    if (
      row.delegate ||
      (channexManagementWorkerPrivileges[row.name]?.[row.privilege] !== true &&
        !(row.privilege === "SELECT" && toleratedReads.has(row.name)))
    )
      fail("table_privileges");
  const columnGrants = (
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS name,a.attname,privilege,has_column_privilege($1,c.oid,a.attname,privilege||' WITH GRANT OPTION') AS delegate FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege($1,c.oid,a.attname,privilege)`,
      [role],
    )
  ).rows;
  for (const row of columnGrants) {
    const grant = channexManagementWorkerPrivileges[row.name]?.[row.privilege];
    if (
      row.delegate ||
      !(
        grant === true ||
        (Array.isArray(grant) && grant.includes(row.attname)) ||
        (row.privilege === "SELECT" && toleratedReads.has(row.name))
      )
    )
      fail("column_privileges");
  }
  // D7b: a claimed-only grant must never outrun its insert policy (0522); until the policy exists
  // 0408's scope policy alone would admit the write.
  for (const [name, privileges] of optionalChannexClaimedGrants)
    for (const privilege of privileges)
      if (
        columnGrants.some((row) => row.name === name && row.privilege === privilege) &&
        !policyRows.some(
          (row) =>
            `${row.schemaname}.${row.tablename}` === name &&
            row.policyname === "channex_management_worker_insert" &&
            row.cmd === privilege,
        )
      )
        fail("claimed_grant_before_policy");
  for (const [name, privileges] of Object.entries(channexManagementWorkerPrivileges)) {
    const deliveryPending = optionalChannexDeliveryRelations.has(name) && !options.offerDelivery;
    if (
      name !== "platform.channex_management_worker_properties" &&
      name !== "platform.channex_management_worker_operations" &&
      name !== "finance.online_card_readiness" &&
      !deliveryPending &&
      !relations.find((row) => row.name === name)?.rls
    )
      fail("rls_disabled");
    if (options.allowMissingGrants || deliveryPending) continue;
    for (const [privilege, columns] of Object.entries(privileges)) {
      // D7b: a claimed-only grant is required only when the claimed scope is asserted.
      if (!options.claimedScope && optionalChannexClaimedGrants.get(name)?.includes(privilege))
        continue;
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
  if (options.connectionScope) {
    const rows = (
      await client.query("SELECT operation_type FROM platform.channex_management_worker_operations")
    ).rows;
    if (rows.length !== 1 || rows[0].operation_type !== "enable") fail("operation_scope_mismatch");
  }
  // VAY-2108: the claimed scope is exactly ARI plus published-offer provisioning. Its SELECT comes
  // from the platform's claimed grant, never the matrix (this preflight gates every next-api
  // start); without it the claimed helper grants nothing. The grant may land before an image asks
  // for claimedScope, so only an explicit claimedScope requires it.
  const readable = (
    await client.query(
      "SELECT has_table_privilege($1,'platform.channex_management_worker_claimed_operations','SELECT') AS ok",
      [role],
    )
  ).rows[0]?.ok;
  const claimed = readable
    ? (
        await client.query(
          "SELECT operation_type FROM platform.channex_management_worker_claimed_operations ORDER BY 1",
        )
      ).rows
        .map((row) => row.operation_type)
        .join(",")
    : "";
  if (claimed !== "provision,sync_ari" && (options.claimedScope || claimed !== ""))
    fail("claimed_scope_mismatch");
}

// Attest transitive invoker functions, enabled triggers and the invoker view as
// well as policies. A matching grant list alone must not accept a disabled guard.
// The VAY-2055 connection-scope helper keeps PUBLIC execution on purpose: it is
// referenced from policies every runtime role evaluates and returns true for
// them before reading worker tables. Its definition is attested here instead.
// The canary allowlist and the operation scope share this login; a provisioned
// canary property stays readable to a connection-only worker by design.
export const channexWorkerCatalogSql = `
WITH relations AS (SELECT oid FROM pg_class WHERE oid=ANY($1::regclass[])),
functions AS (
  SELECT tgfoid AS oid FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM relations) AND NOT tgisinternal
  UNION SELECT to_regprocedure(name)::oid FROM unnest(ARRAY[
    'platform.channex_management_worker_scope(text,text,uuid)',
    'platform.channex_management_worker_connection_scope(text,text)',
    'platform.channex_management_worker_claimed_scope(text,text)',
    'platform.channex_management_worker_delivery_source(text,text)',
    'platform.channex_management_worker_source(text,text,uuid)',
    'platform.tenant_scope_key(text,uuid,uuid)',
    'platform.valid_tenant_scope(text,uuid,uuid)',
    'pms.claim_channex_external_rate(uuid,text,text,uuid,jsonb)',
    'pms.enqueue_restriction_ari(uuid,text)'
  ]) name WHERE to_regprocedure(name) IS NOT NULL
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
