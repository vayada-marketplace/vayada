import { assertHotelSetupBootstrapLock } from "./hotelSetupHelperOwnerGrants.js";
import { publishHotelSetupPropertySecret } from "./hotelSetupPropertySecretPublication.js";
import { createHash } from "node:crypto";
import type pg from "pg";
import { hotelSetupOrganizationConnection } from "./hotelSetupOrganizationRoleStaging.js";
import { proveFreshHotelSetupNativeCredential } from "./hotelSetupFreshNativeCredential.js";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import {
  lockHotelSetupPropertyBootstrapAuthority,
  type stageHotelSetupPropertyRole,
} from "./hotelSetupPropertyRoleStaging.js";

/** Isolated provisioner only; serving admission waits for proof and readiness COMMIT. */
export async function activateVerifiedHotelSetupPropertyRole(input: {
  adminDatabaseUrl: string;
  bootstrapHolder?: pg.Client;
  nativeDatabaseUrl: string;
  databaseEndpoint: string;
  staged: Awaited<ReturnType<typeof stageHotelSetupPropertyRole>>;
  /** Trusted operational image imports only; never supplied by an HTTP caller. */
  proveSecondary?: (client: pg.Client, scope: Readonly<typeof input.staged>) => Promise<void>;
  publish?: boolean;
}) {
  let admin: pg.Client | undefined;
  let failed = false;
  let publicationAttempted = false;
  let publicationSucceeded = false;
  let commitAttempted = false;
  const { nativeDatabaseUrl, adminDatabaseUrl, databaseEndpoint } = input;
  const { login, roleOid, propertyId, organizationId, actorUserId, operation, automatic } =
    input.staged ?? {};
  const scope = Object.freeze({
    propertyId,
    organizationId,
    actorUserId,
    operation,
    ...(automatic ? { automatic } : {}),
  });
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
    admin = hotelSetupOrganizationConnection(adminDatabaseUrl, databaseEndpoint);
    admin.on("error", () => {
      failed = true;
    });
    await admin.connect();
    if (input.bootstrapHolder) {
      // Try rather than queue behind a migrator waiting on the coordinator.
      const lock = await admin.query<{ held: boolean }>(
        "SELECT pg_catalog.pg_try_advisory_lock_shared(8734516) AS held",
      );
      if (lock.rows[0]?.held !== true) throw new Error();
      await assertHotelSetupBootstrapLock(input.bootstrapHolder);
    }
    await admin.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [
      `hotel_setup_property_activation:${login}`,
    ]);
    await admin.query("BEGIN");
    await lockHotelSetupPropertyBootstrapAuthority(admin, scope);
    const staged = await admin.query(
      `SELECT oid FROM pg_catalog.pg_roles r WHERE
      oid=$1::oid AND rolname=$2 AND NOT rolcanlogin
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
    commitAttempted = true;
    await admin.query("COMMIT");
    if (failed) throw new Error();
    await proveFreshHotelSetupNativeCredential(
      { nativeDatabaseUrl, databaseEndpoint, login, roleOid },
      async (client) => {
        await checkHotelSetupPropertyCredential(client, scope);
        if (failed) throw new Error();
        await proveSecondary?.(client, stagedScope);
        if (failed) throw new Error();
      },
    );
    if (failed) throw new Error();
    let publication;
    if (publish) {
      publicationAttempted = true;
      publication = await publishHotelSetupPropertySecret({
        admin,
        proveSecondary: proveSecondary!,
        nativeDatabaseUrl,
        databaseEndpoint,
        staged: stagedScope,
      });
      publicationSucceeded = true;
      if (failed) throw new Error();
    }
    return { ...stagedScope, ...(publication ? { publication } : {}) };
  } catch (error) {
    await admin?.query("ROLLBACK").catch(() => undefined);
    // Readiness COMMIT can succeed despite a lost acknowledgement. Do not disable
    // a possibly admitted identity; inspect this exact attempt before cleanup.
    if (
      publicationSucceeded ||
      (error as { code?: unknown } | null)?.code ===
        "hotel_setup_property_readiness_inspection_required"
    )
      throw new Error("Hotel setup property readiness requires recovery inspection");
    // Committed or uncertain credentials remain pending; never reset their password or adopt them.
    if (publicationAttempted)
      throw new Error("Hotel setup property publication requires recovery inspection");
    throw new Error(
      commitAttempted
        ? "Hotel setup property activation requires recovery inspection"
        : "Hotel setup property activation verification failed",
    );
  } finally {
    await admin?.end().catch(() => undefined);
  }
}
