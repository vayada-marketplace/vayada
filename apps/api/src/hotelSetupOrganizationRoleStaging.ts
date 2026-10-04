import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import {
  HOTEL_SETUP_CREATION_PRIVILEGES,
  HOTEL_SETUP_CREATION_RLS_HELPERS,
} from "./hotelSetupCreationPrivileges.js";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import { lockHotelSetupCreationPermissions } from "./hotelSetupMembership.js";

export type HotelSetupOrganizationBootstrapScope = {
  organizationId: string;
  actorUserId: string;
};

export function hotelSetupOrganizationRolePrefix(organizationId: string) {
  return `vayada_next_hotel_setup_org_${createHash("sha256")
    .update(`${organizationId.toLowerCase()}:creation`)
    .digest("hex")
    .slice(0, 16)}_`;
}

/** Operational helpers only. Credentials never enter the serving configuration. */
export function hotelSetupOrganizationConnection(databaseUrl: string, databaseEndpoint: string) {
  const url = parseHotelSetupDatabaseUrl(
    databaseUrl,
    databaseEndpoint,
    decodeURIComponent(new URL(databaseUrl).username),
  );
  return new pg.Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    options: "-c search_path=pg_catalog",
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
  });
}

export async function lockHotelSetupOrganizationBootstrapAuthority(
  admin: pg.Client,
  scope: HotelSetupOrganizationBootstrapScope,
) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![scope.organizationId, scope.actorUserId].every((id) => uuid.test(id))) throw new Error();
  const organization = await admin.query(
    `SELECT id FROM identity.organizations WHERE id=$1::uuid
     AND kind='hotel_group' AND status='active' FOR UPDATE`,
    [scope.organizationId],
  );
  if (organization.rows.length !== 1 || !(await lockHotelSetupCreationPermissions(admin, scope)))
    throw new Error("Hotel setup organization authority unavailable");
}

/** VAY-965 first publication only. A durable disabled attempt is never adopted. */
export async function stageHotelSetupOrganizationRole(input: {
  adminDatabaseUrl: string;
  databaseEndpoint: string;
  scope: HotelSetupOrganizationBootstrapScope;
}) {
  let admin: pg.Client | undefined;
  let failed = false;
  let incompleteGrant = false;
  let commitAttempted = false;
  const scope = Object.freeze({
    organizationId: input.scope.organizationId,
    actorUserId: input.scope.actorUserId,
  });
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (![scope.organizationId, scope.actorUserId].every((id) => uuid.test(id))) throw new Error();
    admin = hotelSetupOrganizationConnection(input.adminDatabaseUrl, input.databaseEndpoint);
    admin.on("error", () => {
      failed = true;
    });
    admin.on("notice", (notice) => {
      if (notice.code === "01007") incompleteGrant = true;
    });
    await admin.connect();
    await admin.query("BEGIN");
    await admin.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
      [`hotel_setup_organization:${scope.organizationId.toLowerCase()}`],
    );
    await lockHotelSetupOrganizationBootstrapAuthority(admin, scope);
    const prefix = hotelSetupOrganizationRolePrefix(scope.organizationId);
    const existing = await admin.query(
      `SELECT database_login,credential_role_oid,credential_secret_version,credential_ready_at
       FROM platform.hotel_setup_creation_scopes
       WHERE organization_id=$1::uuid FOR UPDATE`,
      [scope.organizationId],
    );
    const staged = await admin.query(
      "SELECT oid FROM pg_catalog.pg_roles WHERE pg_catalog.left(rolname::text,length($1))=$1",
      [prefix],
    );
    if (failed || existing.rows.length || staged.rows.length) throw new Error();
    const login = `${prefix}${randomBytes(6).toString("hex")}`;
    const role = admin.escapeIdentifier(login);
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT vayada_next_hotel_setup_scope TO ${role}
      WITH INHERIT TRUE, SET FALSE`);
    const url = new URL(input.databaseEndpoint);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(decodeURIComponent(url.pathname.slice(1)))} TO ${role}`,
    );
    const schemas = [
      ...new Set(Object.keys(HOTEL_SETUP_CREATION_PRIVILEGES).map((name) => name.split(".")[0]!)),
    ];
    await admin.query(`GRANT USAGE ON SCHEMA ${schemas.join(",")} TO ${role}`);
    for (const [table, privileges] of Object.entries(HOTEL_SETUP_CREATION_PRIVILEGES))
      for (const [privilege, columns] of Object.entries(privileges))
        await admin.query(`GRANT ${privilege}(${columns.join(",")}) ON ${table} TO ${role}`);
    const helper = await admin.query<{ safe: boolean }>(
      `SELECT NOT prosecdef AS safe FROM pg_catalog.pg_proc WHERE oid=ANY($1::regprocedure[])`,
      [HOTEL_SETUP_CREATION_RLS_HELPERS],
    );
    if (helper.rows.length !== 2 || helper.rows.some(({ safe }) => safe !== true))
      throw new Error();
    for (const signature of HOTEL_SETUP_CREATION_RLS_HELPERS)
      await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`);
    const identity = await admin.query<{ oid: number }>(
      "SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1",
      [login],
    );
    if (failed || incompleteGrant || identity.rows.length !== 1) throw new Error();
    commitAttempted = true;
    await admin.query("COMMIT");
    if (failed) throw new Error();
    return { login, roleOid: identity.rows[0]!.oid, ...scope };
  } catch {
    await admin?.query("ROLLBACK").catch(() => undefined);
    throw new Error(
      commitAttempted
        ? "Hotel setup organization staging requires recovery inspection"
        : "Hotel setup organization staging failed",
    );
  } finally {
    await admin?.end().catch(() => undefined);
  }
}
