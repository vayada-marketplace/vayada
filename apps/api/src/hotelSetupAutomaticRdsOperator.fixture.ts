import { randomBytes } from "node:crypto";
import pg from "pg";
import { vi } from "vitest";
import { HOTEL_SETUP_CREATION_RLS_HELPERS } from "./hotelSetupCreationPrivileges.js";

const manager = "vay965_fixture_rds_role_manager";
const scopes = [
  "vayada_next_hotel_setup_scope",
  "vayada_next_hotel_setup_property_scope",
  "vayada_next_hotel_setup_logo_scope",
];
// Production RDS role management: a fresh role gets no creator edge and its parent edge is
// recorded by the bootstrap superuser. Vanilla PostgreSQL 16+ records an ADMIN creator edge,
// which would make the operator an implicit member of every native scope. Only these exact
// role-management statements borrow the fixture manager; every read, ACL grant, row lock and
// RLS check keeps the restricted operator's own privileges. Whole statements must match.
const login = '"vayada_next_hotel_setup_(?:org|property|logo)_[a-f0-9]{16}_[a-f0-9]{12}"';
const roleManagement = new RegExp(
  [
    `CREATE ROLE ${login} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `GRANT vayada_next_hotel_setup_(?:scope|property_scope|logo_scope) TO ${login} WITH INHERIT TRUE, SET FALSE`,
    "DO \\$\\$ BEGIN EXECUTE pg_catalog\\.format\\('ALTER ROLE %I LOGIN PASSWORD %L', " +
      "pg_catalog\\.current_setting\\('(vay965\\.organization|vay1092\\.property)_login'\\), " +
      "pg_catalog\\.current_setting\\('\\1_password'\\)\\); END \\$\\$",
  ]
    .map((statement) => `^${statement}$`)
    .join("|"),
);

/** Owned disposable database only. Mirrors the inspected production operator posture:
 * NOSUPERUSER CREATEROLE, rds_superuser-style membership, grantable relation ACLs,
 * no BYPASSRLS, no pg_authid access and no helper-function grant option. */
export async function createRdsOperatorFixture(
  superUrl: string,
  /** Reproduce vanilla PostgreSQL 16+: the operator itself creates roles and keeps the edge. */
  options: { vanillaCreator?: boolean } = {},
) {
  const url = new URL(superUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    !/^\/vay1092_automatic_rds_[a-z0-9_]*test$/.test(url.pathname) ||
    url.search !== "?sslmode=verify-full"
  )
    throw new Error("Owned disposable restricted-operator database required");
  const database = decodeURIComponent(url.pathname.slice(1));
  const su = new pg.Client({ connectionString: superUrl });
  await su.connect();
  const adminPassword = randomBytes(36).toString("base64url");
  const ownerPassword = randomBytes(36).toString("base64url");
  const existing = await su.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])", [
    ["vayada_admin", manager, "rds_superuser"],
  ]);
  if (existing.rows.length) {
    await su.end();
    throw new Error("Restricted operator fixture roles must not pre-exist");
  }
  const native = "^vayada_next_hotel_setup_(org|property|logo)_[a-f0-9]{16}_[a-f0-9]{12}$";
  const earlier = (
    await su.query<{ oid: number }>("SELECT oid FROM pg_roles WHERE rolname ~ $1", [native])
  ).rows.map(({ oid }) => oid);
  // A superuser revoke acts as the object owner, and column grants made through a table grant
  // option survive its cascade. Revoke those as their grantor, then cascade the rest.
  const revokeOperator = async () => {
    const operator = await su.query("SELECT 1 FROM pg_roles WHERE rolname='vayada_admin'");
    if (!operator.rows.length) return;
    const columns = await su.query<{ sql: string }>(
      `SELECT format('REVOKE %s(%I) ON %s FROM %I',x.privilege_type,a.attname,a.attrelid::regclass,g.rolname) AS sql
       FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x JOIN pg_roles g ON g.oid=x.grantee
       WHERE x.grantor='vayada_admin'::regrole`,
    );
    await su.query("SET ROLE vayada_admin");
    try {
      for (const { sql } of columns.rows) await su.query(sql);
    } finally {
      await su.query("RESET ROLE");
    }
    await su.query("DROP OWNED BY vayada_admin CASCADE");
  };
  const cleanup = async () => {
    try {
      await revokeOperator();
      // Only identities this fixture's operator created; never another suite's roles.
      const natives = await su.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname ~ $1 AND NOT oid=ANY($2::oid[])",
        [native, earlier],
      );
      for (const { rolname } of natives.rows) {
        await su.query(`DROP OWNED BY ${su.escapeIdentifier(rolname)}`);
        await su.query(`DROP ROLE ${su.escapeIdentifier(rolname)}`);
      }
      for (const role of ["vayada_admin", manager, "rds_superuser"])
        await su.query(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await su.end();
    }
  };
  try {
    await su.query("CREATE ROLE rds_superuser NOLOGIN NOINHERIT");
    await su.query(`CREATE ROLE ${manager} NOLOGIN SUPERUSER`);
    await su.query(
      `CREATE ROLE vayada_admin LOGIN INHERIT NOSUPERUSER CREATEROLE CREATEDB NOREPLICATION
       NOBYPASSRLS VALID UNTIL '2099-01-01' PASSWORD ${su.escapeLiteral(adminPassword)}`,
    );
    await su.query("GRANT rds_superuser TO vayada_admin WITH INHERIT TRUE, SET TRUE");
    await su.query(`GRANT ${manager} TO vayada_admin WITH INHERIT FALSE, SET TRUE`);
    await su.query(
      `ALTER ROLE vayada_target_prod_user PASSWORD ${su.escapeLiteral(ownerPassword)}`,
    );
    await su.query(
      `GRANT ALL ON DATABASE ${su.escapeIdentifier(database)} TO vayada_admin WITH GRANT OPTION`,
    );
    // Like the inspected RDS operator: grantable relation ACLs, never relation ownership.
    const schemas = await su.query<{ name: string }>(
      `SELECT quote_ident(nspname) AS name FROM pg_namespace
       WHERE nspname !~ '^pg_' AND nspname<>'information_schema' ORDER BY nspname`,
    );
    for (const { name: schema } of schemas.rows)
      await su.query(`GRANT ALL ON SCHEMA ${schema} TO vayada_admin WITH GRANT OPTION;
        GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO vayada_admin WITH GRANT OPTION;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO vayada_admin WITH GRANT OPTION`);
    // Production tenant (0465 repair) and hardened setup RLS helpers are not PUBLIC-executable.
    await su.query(`REVOKE EXECUTE ON FUNCTION platform.tenant_scope_key(text,uuid,uuid),
      platform.valid_tenant_scope(text,uuid,uuid),${HOTEL_SETUP_CREATION_RLS_HELPERS.join(",")} FROM PUBLIC`);
    // Identity RLS initializes these helpers for every reader. The inspected operator reads
    // identity rows (run 37436890909), so it holds plain nongrantable EXECUTE on them.
    await su.query(
      `GRANT EXECUTE ON FUNCTION ${HOTEL_SETUP_CREATION_RLS_HELPERS.join(",")} TO vayada_admin`,
    );
    const posture = await su.query(
      `SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,
        pg_catalog.has_table_privilege('vayada_admin','pg_catalog.pg_authid','SELECT') AS catalog_select,
        pg_catalog.has_table_privilege('vayada_admin','pg_catalog.pg_authid','UPDATE') AS catalog_update,
        (SELECT bool_or(pg_catalog.pg_has_role('vayada_admin',s,'MEMBER')) FROM unnest($1::text[]) s) AS scope_member,
        (SELECT rolsuper FROM pg_roles WHERE rolname='vayada_target_prod_user') AS owner_super,
        (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_class
          WHERE oid='platform.hotel_setup_creation_scopes'::regclass) AS scope_owner
       FROM pg_roles r WHERE r.rolname='vayada_admin'`,
      [scopes],
    );
    const expected = {
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: true,
      catalog_select: false,
      catalog_update: false,
      scope_member: false,
      owner_super: false,
      scope_owner: "vayada_target_prod_user",
    };
    if (JSON.stringify(posture.rows) !== JSON.stringify([expected]))
      throw new Error("Restricted operator fixture posture mismatch");
  } catch (error) {
    await cleanup();
    throw error;
  }
  const endpoint = new URL(superUrl);
  endpoint.username = endpoint.password = endpoint.search = "";
  const credentialUrl = (user: string, password: string) => {
    const result = new URL(superUrl);
    result.username = user;
    result.password = password;
    return result.toString();
  };
  const operations = { catalog: 0, borrowed: 0, statements: [] as string[] };
  const original = pg.Client.prototype.query;
  const shim = vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const run = () =>
      (original as unknown as (...values: unknown[]) => Promise<pg.QueryResult>).apply(this, args);
    if (this.user !== "vayada_admin" || typeof args[0] !== "string") return run();
    const sql = args[0];
    operations.statements.push(sql);
    if (/\b(?:FROM|JOIN)\s+(?:pg_catalog\.)?pg_authid\b/i.test(sql)) operations.catalog++;
    const execute = async () => {
      const statement = sql.replace(/\s+/g, " ").trim();
      if (
        !roleManagement.test(statement) ||
        (options.vanillaCreator && statement.startsWith("CREATE ROLE "))
      )
        return run();
      operations.borrowed++;
      const call = original as unknown as (sql: string) => Promise<unknown>;
      await call.call(this, `SET ROLE ${manager}`);
      try {
        return await run();
      } finally {
        // Inside an aborted transaction this fails, and ROLLBACK then undoes SET ROLE.
        await call.call(this, "RESET ROLE").catch(() => undefined);
      }
    };
    return execute();
  } as never);
  return {
    su,
    adminDatabaseUrl: credentialUrl("vayada_admin", adminPassword),
    helperOwnerDatabaseUrl: credentialUrl("vayada_target_prod_user", ownerPassword),
    databaseEndpoint: endpoint.toString(),
    operations,
    /** Production shape after every pass: no creator edges and superuser-recorded parents. */
    async nativeMembership() {
      return (
        await su.query<{
          login: string;
          incoming: number;
          parents: number;
          grantor_super: boolean;
        }>(
          `SELECT r.rolname AS login,
            (SELECT count(*)::int FROM pg_auth_members WHERE roleid=r.oid) AS incoming,
            (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS parents,
            (SELECT bool_and(g.rolsuper) FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.grantor
              WHERE m.member=r.oid) AS grantor_super
           FROM pg_roles r
           WHERE r.rolname ~ '^vayada_next_hotel_setup_(org|property|logo)_[a-f0-9]{16}_[a-f0-9]{12}$'
           ORDER BY r.rolname`,
        )
      ).rows;
    },
    revokeOperator,
    async close() {
      shim.mockRestore();
      await cleanup();
    },
  };
}
