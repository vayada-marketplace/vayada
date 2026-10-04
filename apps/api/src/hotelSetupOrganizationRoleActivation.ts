import type pg from "pg";
import { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import {
  hotelSetupOrganizationConnection,
  hotelSetupOrganizationRolePrefix,
  lockHotelSetupOrganizationBootstrapAuthority,
  type stageHotelSetupOrganizationRole,
} from "./hotelSetupOrganizationRoleStaging.js";
import { publishHotelSetupOrganizationSecret } from "./hotelSetupOrganizationSecretPublication.js";

/** Protected first publication only, per the automatic provisioning contract.
 * The fixed operational CLI supplies its bundled compatible rollback preflight. */
export async function activateVerifiedHotelSetupOrganizationRole(input: {
  adminDatabaseUrl: string;
  nativeDatabaseUrl: string;
  databaseEndpoint: string;
  staged: Awaited<ReturnType<typeof stageHotelSetupOrganizationRole>>;
  proveSecondary: typeof checkHotelSetupCreationCredential;
}) {
  let admin: pg.Client | undefined;
  let nativeClient: pg.Client | undefined;
  let failed = false;
  let nativeFailed = false;
  let commitAttempted = false;
  let verifier = "";
  const { login, roleOid, organizationId, actorUserId } = input.staged ?? {};
  const scope = Object.freeze({ organizationId, actorUserId });
  const staged = Object.freeze({ login, roleOid, ...scope });
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      ![organizationId, actorUserId].every((id) => uuid.test(id)) ||
      !Number.isInteger(roleOid) ||
      roleOid <= 0 ||
      !login.startsWith(hotelSetupOrganizationRolePrefix(organizationId)) ||
      !/^vayada_next_hotel_setup_org_[a-f0-9]{16}_[a-f0-9]{12}$/.test(login) ||
      typeof input.proveSecondary !== "function"
    )
      throw new Error();
    const native = parseHotelSetupDatabaseUrl(
      input.nativeDatabaseUrl,
      input.databaseEndpoint,
      login,
    );
    admin = hotelSetupOrganizationConnection(input.adminDatabaseUrl, input.databaseEndpoint);
    admin.on("error", () => {
      failed = true;
    });
    await admin.connect();
    await admin.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [
      `hotel_setup_organization:${organizationId.toLowerCase()}`,
    ]);
    await admin.query("BEGIN");
    await lockHotelSetupOrganizationBootstrapAuthority(admin, scope);
    const identity = await admin.query(
      `SELECT oid FROM pg_catalog.pg_authid r WHERE
      oid=$1::oid AND rolname=$2 AND NOT rolcanlogin AND rolpassword IS NULL
      AND rolvaliduntil IS NULL AND NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
      AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=r.oid)=1
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid=m.roleid
        WHERE m.member=r.oid AND p.rolname='vayada_next_hotel_setup_scope'
          AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
        WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND NOT EXISTS (SELECT 1 FROM platform.hotel_setup_creation_scopes
        WHERE database_login=$2 OR organization_id=$3::uuid)`,
      [roleOid, login, organizationId],
    );
    if (failed || identity.rows.length !== 1) throw new Error();
    await admin.query(
      `SELECT pg_catalog.set_config('vay965.organization_login',$1,true),
      pg_catalog.set_config('vay965.organization_password',$2,true)`,
      [login, decodeURIComponent(native.password)],
    );
    await admin.query(`DO $$ BEGIN EXECUTE pg_catalog.format('ALTER ROLE %I LOGIN PASSWORD %L',
      pg_catalog.current_setting('vay965.organization_login'),
      pg_catalog.current_setting('vay965.organization_password')); END $$`);
    await admin.query(
      `INSERT INTO platform.hotel_setup_creation_scopes
      (database_login,organization_id) VALUES($1,$2::uuid)`,
      [login, organizationId],
    );
    const password = await admin.query<{ verifier: string }>(
      "SELECT rolpassword AS verifier FROM pg_catalog.pg_authid WHERE oid=$1::oid AND rolname=$2",
      [roleOid, login],
    );
    verifier = password.rows[0]?.verifier ?? "";
    if (failed || !verifier) throw new Error();
    commitAttempted = true;
    await admin.query("COMMIT");
    if (failed) throw new Error();
    nativeClient = hotelSetupOrganizationConnection(
      input.nativeDatabaseUrl,
      input.databaseEndpoint,
    );
    nativeClient.on("error", () => {
      nativeFailed = true;
    });
    await nativeClient.connect();
    const authenticated = await nativeClient.query<{ oid: number }>(
      "SELECT session_user::regrole::oid AS oid",
    );
    if (authenticated.rows[0]?.oid !== roleOid || failed || nativeFailed) throw new Error();
    await checkHotelSetupCreationCredential(nativeClient, scope);
    if (failed || nativeFailed) throw new Error();
    await input.proveSecondary(nativeClient, scope);
    if (failed || nativeFailed) throw new Error();
    await nativeClient.end();
    nativeClient = undefined;
    if (failed || nativeFailed) throw new Error();
    const publication = await publishHotelSetupOrganizationSecret({
      admin,
      staged,
      expectedVerifier: verifier,
      nativeDatabaseUrl: input.nativeDatabaseUrl,
      databaseEndpoint: input.databaseEndpoint,
    });
    if (failed) throw new Error();
    return { ...staged, publication };
  } catch {
    await nativeClient?.end().catch(() => undefined);
    nativeClient = undefined;
    await admin?.query("ROLLBACK").catch(() => undefined);
    if (commitAttempted) {
      try {
        await admin!.query("BEGIN");
        await admin!.query("SELECT id FROM identity.organizations WHERE id=$1::uuid FOR UPDATE", [
          organizationId,
        ]);
        const identity = await admin!.query<{ rolcanlogin: boolean; rolpassword: string | null }>(
          "SELECT rolcanlogin,rolpassword FROM pg_catalog.pg_authid WHERE oid=$1::oid AND rolname=$2",
          [roleOid, login],
        );
        const assignments = await admin!.query<{
          database_login: string;
          organization_id: string;
          credential_role_oid: number | null;
          credential_secret_version: string | null;
          credential_ready_at: Date | null;
        }>(
          `SELECT database_login,organization_id,credential_role_oid,credential_secret_version,credential_ready_at
          FROM platform.hotel_setup_creation_scopes WHERE database_login=$1 OR organization_id=$2::uuid FOR UPDATE`,
          [login, organizationId],
        );
        const role = identity.rows[0];
        if (!role || identity.rows.length !== 1) throw new Error();
        if (
          !(
            role.rolcanlogin === false &&
            role.rolpassword === null &&
            assignments.rows.length === 0
          )
        ) {
          const assignment = assignments.rows[0];
          // Any readiness may be a committed admission after a lost acknowledgement.
          // Preserve it for inspection; never disable a ready or changed identity blindly.
          if (
            role.rolpassword !== verifier ||
            assignments.rows.length !== 1 ||
            assignment?.database_login !== login ||
            assignment.organization_id !== organizationId.toLowerCase() ||
            assignment.credential_role_oid !== null ||
            assignment.credential_secret_version !== null ||
            assignment.credential_ready_at !== null
          )
            throw new Error();
          await admin!.query(`ALTER ROLE ${admin!.escapeIdentifier(login)} NOLOGIN PASSWORD NULL`);
          await admin!.query(
            "DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1 AND organization_id=$2::uuid",
            [login, organizationId],
          );
          await admin!.query(
            "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND pid<>pg_catalog.pg_backend_pid()",
            [login],
          );
        }
        await admin!.query("COMMIT");
        if (failed) throw new Error();
      } catch {
        await admin?.query("ROLLBACK").catch(() => undefined);
        throw new Error("Hotel setup organization activation requires recovery inspection");
      }
    }
    throw new Error(
      commitAttempted
        ? "Hotel setup organization activation requires recovery inspection"
        : "Hotel setup organization activation verification failed",
    );
  } finally {
    await admin?.end().catch(() => undefined);
  }
}
