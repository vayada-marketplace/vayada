import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { stageHotelSetupPropertyRole } from "../hotelSetupPropertyRoleStaging.js";
import { activateVerifiedHotelSetupPropertyRole } from "../hotelSetupPropertyRoleActivation.js";
import type { HotelSetupOperation } from "../hotelSetupCommandScope.js";
import type { checkHotelSetupPropertyCredential } from "./hotelSetupPropertyPreflight.js";

/** Protected manual operational image only. Its driver must prove blocked public admission,
 * zero desired/running/pending private tasks and exclusive release ownership through publication. */
export async function runHotelSetupPropertyBootstrap(env: NodeJS.ProcessEnv = process.env) {
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
    });
    const native = new URL(adminDatabaseUrl);
    native.username = staged.login;
    native.password = randomBytes(36).toString("base64url");
    const nativeDatabaseUrl = native.toString();
    const receipt = await activateVerifiedHotelSetupPropertyRole({
      adminDatabaseUrl,
      databaseEndpoint,
      staged,
      nativeDatabaseUrl,
      proveSecondary: secondary.checkHotelSetupPropertyCredential,
      publish: true,
    });
    console.log(JSON.stringify({ status: "PASS", ...receipt }));
    return 0;
  } catch {
    // Never relay pg/AWS diagnostics, connection strings or password verifiers.
    // An unknown commit/publication must be inspected; never automatically retry.
    console.error(
      JSON.stringify({
        status: "FAIL",
        code: "hotel_setup_property_bootstrap_inspection_required",
      }),
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runHotelSetupPropertyBootstrap();
