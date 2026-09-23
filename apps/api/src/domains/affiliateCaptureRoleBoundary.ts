import type pg from "pg";

export const AFFILIATE_CAPTURE_ROLE = "vayada_next_affiliate_capture";

/** Deny-only preparation check. Passing does not authorize live capture. */
export async function assertAffiliateCaptureRoleHasNoWriteGrants(
  client: Pick<pg.Client, "query">,
  role = AFFILIATE_CAPTURE_ROLE,
): Promise<void> {
  const fail = (reason: string): never => {
    throw new Error(`affiliate_capture_role_${reason}`);
  };
  const account = (
    await client.query(
      `SELECT oid, rolcanlogin AND NOT (
         rolsuper OR rolcreaterole OR rolcreatedb OR rolinherit OR rolbypassrls OR rolreplication
       ) AS safe
       FROM pg_catalog.pg_roles WHERE rolname=$1`,
      [role],
    )
  ).rows[0];
  if (!account?.safe) fail("unsafe");
  const privileged = await client.query(
    `SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=$1 OR roleid=$1
     UNION ALL SELECT 1 FROM pg_catalog.pg_shdepend
       WHERE refclassid='pg_catalog.pg_authid'::pg_catalog.regclass
         AND refobjid=$1 AND deptype='o'`,
    [account.oid],
  );
  if (privileged.rowCount) fail("membership_or_owner");
  const ddl = await client.query(
    `SELECT 1 WHERE pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'CREATE')
                OR pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'TEMP')
     UNION ALL SELECT 1 FROM pg_catalog.pg_namespace
       WHERE pg_catalog.left(nspname,3)<>'pg_'
         AND pg_catalog.has_schema_privilege($1,oid,'CREATE')
     UNION ALL SELECT 1 FROM pg_catalog.pg_class
       WHERE relkind='S' AND (
         pg_catalog.has_sequence_privilege($1,oid,'USAGE') OR
         pg_catalog.has_sequence_privilege($1,oid,'SELECT') OR
         pg_catalog.has_sequence_privilege($1,oid,'UPDATE')
       )`,
    [role],
  );
  if (ddl.rowCount) fail("ddl_or_sequence");
  const version = Number(
    (await client.query("SHOW server_version_num")).rows[0]?.server_version_num,
  );
  const writes = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    ...(version >= 170000 ? ["MAINTAIN"] : []),
  ];
  const direct = await client.query(
    `SELECT 1 FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
       CROSS JOIN pg_catalog.unnest($2::pg_catalog.text[]) privilege
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND pg_catalog.has_table_privilege($1,relation.oid,privilege)
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_attribute attribute
       JOIN pg_catalog.pg_class relation ON relation.oid=attribute.attrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
       CROSS JOIN pg_catalog.unnest(ARRAY['INSERT','UPDATE','REFERENCES']) privilege
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND attribute.attnum>0 AND NOT attribute.attisdropped
       AND pg_catalog.has_column_privilege($1,relation.oid,attribute.attname,privilege)
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND pg_catalog.has_table_privilege($1,relation.oid,'SELECT WITH GRANT OPTION')
     UNION ALL
     SELECT 1 FROM pg_catalog.pg_attribute attribute
       JOIN pg_catalog.pg_class relation ON relation.oid=attribute.attrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE relation.relkind IN ('r','p','v','m','f')
       AND pg_catalog.left(namespace.nspname,3)<>'pg_'
       AND namespace.nspname<>'information_schema'
       AND attribute.attnum>0 AND NOT attribute.attisdropped
       AND pg_catalog.has_column_privilege(
         $1,relation.oid,attribute.attname,'SELECT WITH GRANT OPTION'
       )`,
    [role, writes],
  );
  if (direct.rowCount) fail("direct_grant");
}
