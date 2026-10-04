import { randomBytes } from "node:crypto";
import type pg from "pg";
import { hotelSetupOrganizationConnection } from "../hotelSetupOrganizationRoleStaging.js";
import {
  assertHotelSetupBootstrapLock,
  HotelSetupHelperGrantInspection,
  type grantFreshHotelSetupHelpers,
} from "../hotelSetupHelperOwnerGrants.js";
import { parseHotelSetupHelperOwnerConfiguration } from "./hotelSetupAutomaticProvisioning.js";
import { pathToFileURL } from "node:url";
import { stageHotelSetupPropertyRole } from "../hotelSetupPropertyRoleStaging.js";
import { activateVerifiedHotelSetupPropertyRole } from "../hotelSetupPropertyRoleActivation.js";
import type { HotelSetupOperation } from "../hotelSetupCommandScope.js";
import type { checkHotelSetupPropertyCredential } from "./hotelSetupPropertyPreflight.js";

/** Protected manual operational image only. Its driver must prove blocked public admission,
 * zero desired/running/pending private tasks and exclusive release ownership through publication. */
let helperPhase:
  | Parameters<NonNullable<Parameters<typeof grantFreshHotelSetupHelpers>[0]["onPhase"]>>[0]
  | undefined;
export async function runHotelSetupPropertyBootstrap(env: NodeJS.ProcessEnv = process.env) {
  helperPhase = undefined;
  let holder: pg.Client | undefined;
  try {
    // Fixed roots: no caller-provided path, module or alternate rollback dependency tree.
    if (import.meta.url !== "file:///app/apps/api/dist/cli/hotelSetupPropertyBootstrap.js")
      throw new Error();
    const secondary: {
      checkHotelSetupPropertyCredential: typeof checkHotelSetupPropertyCredential;
    } = await import(
      pathToFileURL("/proof/rollback/apps/api/dist/cli/hotelSetupPropertyPreflight.js").href
    );
    if (typeof secondary.checkHotelSetupPropertyCredential !== "function") throw new Error();
    const adminDatabaseUrl = env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL ?? "";
    const databaseEndpoint = env.HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT ?? "";
    const ownerDatabaseUrl = parseHotelSetupHelperOwnerConfiguration(env);
    holder = hotelSetupOrganizationConnection(adminDatabaseUrl, databaseEndpoint);
    holder.on("error", () => undefined);
    await holder.connect();
    const lock = await holder.query<{ held: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock_shared(8734516) AS held",
    );
    if (lock.rows[0]?.held !== true) throw new Error();
    const scope = Object.freeze({
      propertyId: env.HOTEL_SETUP_COMMAND_PROPERTY_ID ?? "",
      organizationId: env.HOTEL_SETUP_COMMAND_ORGANIZATION_ID ?? "",
      actorUserId: env.HOTEL_SETUP_COMMAND_ACTOR_USER_ID ?? "",
      operation: env.HOTEL_SETUP_COMMAND_OPERATION as HotelSetupOperation,
    });
    const staged = await stageHotelSetupPropertyRole({
      adminDatabaseUrl,
      databaseEndpoint,
      scope,
      helperOwner: {
        databaseUrl: ownerDatabaseUrl,
        holder,
        onPhase: (receipt) => {
          helperPhase = receipt;
        },
      },
    });
    await assertHotelSetupBootstrapLock(holder);
    const native = new URL(adminDatabaseUrl);
    native.username = staged.login;
    native.password = randomBytes(36).toString("base64url");
    const nativeDatabaseUrl = native.toString();
    const receipt = await activateVerifiedHotelSetupPropertyRole({
      adminDatabaseUrl,
      databaseEndpoint,
      bootstrapHolder: holder,
      staged,
      nativeDatabaseUrl,
      proveSecondary: secondary.checkHotelSetupPropertyCredential,
      publish: true,
    });
    console.log(JSON.stringify({ status: "PASS", ...receipt }));
    return 0;
  } catch (error) {
    if (error instanceof HotelSetupHelperGrantInspection)
      console.error(
        JSON.stringify({
          status: "FAIL",
          code: "hotel_setup_helper_grant_inspection",
          ...error.receipt,
        }),
      );
    // Never relay pg/AWS diagnostics, connection strings or password verifiers.
    // An unknown commit/publication must be inspected; never automatically retry.
    console.error(
      JSON.stringify({
        status: "FAIL",
        code: "hotel_setup_property_bootstrap_inspection_required",
      }),
    );
    return 1;
  } finally {
    await holder?.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const timer = setTimeout(() => {
    console.error(
      JSON.stringify({
        status: "FAIL",
        code: "hotel_setup_property_bootstrap_deadline",
        ...(helperPhase ? { helper: helperPhase } : {}),
      }),
    );
    process.exit(1);
  }, 170_000);
  try {
    process.exitCode = await runHotelSetupPropertyBootstrap();
  } finally {
    clearTimeout(timer);
  }
}
