import { publishHotelSetupPropertySecret } from "./hotelSetupPropertySecretPublication.js";
import { createHash } from "node:crypto";
import pg from "pg";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import {
  lockHotelSetupPropertyBootstrapAuthority,
  type stageHotelSetupPropertyRole,
} from "./hotelSetupPropertyRoleStaging.js";

/** Manual exclusive provisioner only; credential remains unpublished through native proof. */
export async function activateVerifiedHotelSetupPropertyRole(input: {
  adminDatabaseUrl: string;
  nativeDatabaseUrl: string;
  databaseEndpoint: string;
  staged: Awaited<ReturnType<typeof stageHotelSetupPropertyRole>>;
  /** Trusted operational image imports only; never supplied by an HTTP caller. */
  proveSecondary?: (client: pg.Client, scope: Readonly<typeof input.staged>) => Promise<void>;
  publish?: boolean;
}) {
  let admin: pg.Client | undefined;
  let nativeClient: pg.Client | undefined;
  let failed = false;
  let nativeFailed = false;
  let publicationAttempted = false;
  let publicationSucceeded = false;
  let commitAttempted = false;
  let verifier = "";
  const { nativeDatabaseUrl, adminDatabaseUrl, databaseEndpoint } = input;
  const { login, roleOid, propertyId, organizationId, actorUserId, operation } = input.staged ?? {};
  const scope = Object.freeze({ propertyId, organizationId, actorUserId, operation });
  const stagedScope = Object.freeze({ login, roleOid, ...scope });
  const { proveSecondary, publish } = input;
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefix = `vayada_next_hotel_setup_property_${createHash("sha256")
      .update(`${propertyId.toLowerCase()}:${operation}`)
      .digest("hex")
      .slice(0, 16)}_`;
    if (
      ![propertyId, organizationId, actorUserId].every((id) => uuid.test(id)) ||
      !["launch_settings", "currency", "currency_ready", "feature_hub"].includes(operation) ||
      !Number.isInteger(roleOid) ||
      roleOid <= 0 ||
      !login.startsWith(prefix) ||
      !/^[a-f0-9]{12}$/.test(login.slice(prefix.length))
    )
      throw new Error();
    if (publish && !proveSecondary) throw new Error();
    const native = parseHotelSetupDatabaseUrl(nativeDatabaseUrl, databaseEndpoint, login);
    const url = parseHotelSetupDatabaseUrl(
      adminDatabaseUrl,
      databaseEndpoint,
      decodeURIComponent(new URL(adminDatabaseUrl).username),
    );
    const connection = (url: URL) =>
      new pg.Client({
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
    admin = connection(url);
    admin.on("error", () => {
      failed = true;
    });
    await admin.connect();
    await admin.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [
      `hotel_setup_property_activation:${login}`,
    ]);
    await admin.query("BEGIN");
    await lockHotelSetupPropertyBootstrapAuthority(admin, scope);
    const staged = await admin.query(
      `SELECT oid FROM pg_catalog.pg_authid r WHERE
      oid=$1::oid AND rolname=$2 AND NOT rolcanlogin AND rolpassword IS NULL
      AND rolvaliduntil IS NULL AND NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
      AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=r.oid)=1
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid=m.roleid
        WHERE m.member=r.oid AND p.rolname='vayada_next_hotel_setup_property_scope'
        AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend WHERE
        refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND NOT EXISTS (SELECT 1 FROM platform.hotel_setup_property_scopes
        WHERE database_login=$2 OR (property_id=$3::uuid AND operation_class=$4))`,
      [roleOid, login, propertyId, operation],
    );
    if (failed || staged.rows.length !== 1) throw new Error();
    await admin.query(
      `SELECT pg_catalog.set_config('vay1092.property_login',$1,true),
      pg_catalog.set_config('vay1092.property_password',$2,true)`,
      [login, decodeURIComponent(native.password)],
    );
    await admin.query(`DO $$ BEGIN EXECUTE pg_catalog.format('ALTER ROLE %I LOGIN PASSWORD %L',
      pg_catalog.current_setting('vay1092.property_login'),
      pg_catalog.current_setting('vay1092.property_password')); END $$`);
    await admin.query(
      `INSERT INTO platform.hotel_setup_property_scopes
      (database_login,property_id,organization_id,operation_class,active) VALUES($1,$2,$3,$4,TRUE)`,
      [login, propertyId, organizationId, operation],
    );
    const identity = await admin.query<{ verifier: string }>(
      "SELECT rolpassword AS verifier FROM pg_catalog.pg_authid WHERE oid=$1::oid AND rolname=$2",
      [roleOid, login],
    );
    verifier = identity.rows[0]?.verifier ?? "";
    if (failed || !verifier) throw new Error();
    commitAttempted = true;
    await admin.query("COMMIT");
    if (failed) throw new Error();
    nativeClient = connection(native);
    nativeClient.on("error", () => {
      nativeFailed = true;
    });
    await nativeClient.connect();
    await checkHotelSetupPropertyCredential(nativeClient, scope);
    if (failed || nativeFailed) throw new Error();
    await proveSecondary?.(nativeClient, stagedScope);
    if (failed || nativeFailed) throw new Error();
    await nativeClient.end();
    nativeClient = undefined;
    if (failed || nativeFailed) throw new Error();
    let publication;
    if (publish) {
      publicationAttempted = true;
      publication = await publishHotelSetupPropertySecret({
        admin,
        expectedVerifier: verifier,
        nativeDatabaseUrl,
        databaseEndpoint,
        staged: stagedScope,
      });
      publicationSucceeded = true;
      if (failed) throw new Error();
    }
    return { ...stagedScope, ...(publication ? { publication } : {}) };
  } catch (error) {
    await nativeClient?.end().catch(() => undefined);
    nativeClient = undefined;
    await admin?.query("ROLLBACK").catch(() => undefined);
    // Readiness COMMIT can succeed despite a lost acknowledgement. Do not disable
    // a possibly admitted identity; inspect this exact attempt before cleanup.
    if (
      publicationSucceeded ||
      (error as { code?: unknown } | null)?.code ===
        "hotel_setup_property_readiness_inspection_required"
    )
      throw new Error("Hotel setup property readiness requires recovery inspection");
    if (commitAttempted) {
      try {
        await admin!.query("BEGIN");
        const identity = await admin!.query<{ rolcanlogin: boolean; rolpassword: string | null }>(
          "SELECT rolcanlogin,rolpassword FROM pg_catalog.pg_authid WHERE oid=$1::oid AND rolname=$2",
          [roleOid, login],
        );
        const assignment = await admin!.query<{
          property_id: string;
          organization_id: string;
          operation_class: string;
        }>(
          `SELECT property_id,organization_id,operation_class FROM platform.hotel_setup_property_scopes
           WHERE database_login=$1 AND credential_role_oid IS NULL
             AND credential_secret_version IS NULL AND credential_ready_at IS NULL FOR UPDATE`,
          [login],
        );
        const role = identity.rows[0];
        if (!role) throw new Error();
        if (
          !(role.rolcanlogin === false && role.rolpassword === null && assignment.rows.length === 0)
        ) {
          const assigned = assignment.rows[0];
          if (
            role.rolpassword !== verifier ||
            assignment.rows.length !== 1 ||
            assigned?.property_id !== propertyId.toLowerCase() ||
            assigned.organization_id !== organizationId.toLowerCase() ||
            assigned.operation_class !== operation
          )
            throw new Error();
          await admin!.query(`ALTER ROLE ${admin!.escapeIdentifier(login)} NOLOGIN PASSWORD NULL`);
          await admin!.query(
            "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
            [login],
          );
          await admin!.query(
            "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND pid<>pg_catalog.pg_backend_pid()",
            [login],
          );
        }
        await admin!.query("COMMIT");
        if (failed) throw new Error();
      } catch {
        throw new Error("Hotel setup property activation requires recovery inspection");
      }
    }
    if (publicationAttempted)
      throw new Error("Hotel setup property publication requires recovery inspection");
    throw new Error("Hotel setup property activation verification failed");
  } finally {
    await admin?.end().catch(() => undefined);
  }
}
