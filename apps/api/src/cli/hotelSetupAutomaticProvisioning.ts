import { pathToFileURL } from "node:url";
import {
  HotelSetupHelperGrantInspection,
  type grantFreshHotelSetupHelpers,
} from "../hotelSetupHelperOwnerGrants.js";
import { parseHotelSetupDatabaseUrl } from "../hotelSetupCommandServiceConfig.js";
import { reconcileHotelSetupAutomaticScopes } from "../hotelSetupAutomaticReconciliation.js";
import type { checkHotelSetupCreationCredential } from "./hotelSetupCreationPreflight.js";
import type { checkHotelSetupPropertyCredential } from "./hotelSetupPropertyPreflight.js";
import type { HotelSetupAutomaticMode } from "../hotelSetupAutomaticDiscovery.js";

const host = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
const databaseEndpoint = `postgresql://${host}:5432/vayada_target_prod`;

/** Exact injected SSM shape; normalize only the reviewed database and TLS mode. */
export function parseHotelSetupAutomaticConfiguration(env: NodeJS.ProcessEnv): {
  mode: HotelSetupAutomaticMode;
  adminDatabaseUrl: string;
  databaseEndpoint: string;
} {
  const mode = env.HOTEL_SETUP_AUTOMATIC_MODE;
  const url = new URL(env.HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL ?? "");
  if (
    (mode !== "organization" && mode !== "property") ||
    url.protocol !== "postgresql:" ||
    url.hostname !== host ||
    url.port !== "5432" ||
    url.pathname !== "/postgres" ||
    url.username !== "vayada_admin" ||
    url.hash ||
    url.search !== "?sslmode=require" ||
    env.NODE_EXTRA_CA_CERTS !== "/runtime/rds-ca.pem" ||
    (env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1")
  )
    throw new Error();
  url.pathname = "/vayada_target_prod";
  url.search = "?sslmode=verify-full";
  parseHotelSetupDatabaseUrl(url.toString(), databaseEndpoint, "vayada_admin");
  return { mode, adminDatabaseUrl: url.toString(), databaseEndpoint };
}

/** Operational secret injection only; ordinary serving tasks never receive this URL. */
export function parseHotelSetupHelperOwnerConfiguration(
  env: NodeJS.ProcessEnv,
  trustedCaPath: "/runtime/rds-ca.pem" | "/tmp/hotel-setup-rds.pem" = "/runtime/rds-ca.pem",
) {
  const url = new URL(env.HOTEL_SETUP_HELPER_OWNER_DATABASE_URL ?? "");
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== host ||
    url.port !== "5432" ||
    url.pathname !== "/vayada_target_prod" ||
    url.username !== "vayada_target_prod_user" ||
    url.hash ||
    url.search !== "?sslmode=require" ||
    env.NODE_EXTRA_CA_CERTS !== trustedCaPath ||
    (env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1")
  )
    throw new Error();
  url.pathname = "/vayada_target_prod";
  url.search = "?sslmode=verify-full";
  parseHotelSetupDatabaseUrl(url.toString(), databaseEndpoint, "vayada_target_prod_user");
  return url.toString();
}
let helperPhase:
  | Parameters<NonNullable<Parameters<typeof grantFreshHotelSetupHelpers>[0]["onPhase"]>>[0]
  | undefined;

export async function runHotelSetupAutomaticProvisioning(env: NodeJS.ProcessEnv = process.env) {
  helperPhase = undefined;
  try {
    if (import.meta.url !== "file:///app/apps/api/dist/cli/hotelSetupAutomaticProvisioning.js")
      throw new Error();
    const config = parseHotelSetupAutomaticConfiguration(env);
    const helperOwnerDatabaseUrl = parseHotelSetupHelperOwnerConfiguration(env);
    const creation: {
      checkHotelSetupCreationCredential?: typeof checkHotelSetupCreationCredential;
    } =
      config.mode === "organization"
        ? await import(
            pathToFileURL("/proof/rollback/apps/api/dist/cli/hotelSetupCreationPreflight.js").href
          )
        : {};
    const property: {
      checkHotelSetupPropertyCredential?: typeof checkHotelSetupPropertyCredential;
    } =
      config.mode === "property"
        ? await import(
            pathToFileURL("/proof/rollback/apps/api/dist/cli/hotelSetupPropertyPreflight.js").href
          )
        : {};
    const receipt = await reconcileHotelSetupAutomaticScopes({
      ...config,
      helperOwnerDatabaseUrl,
      onHelperPhase: (receipt) => {
        helperPhase = receipt;
      },
      proveOrganization: creation.checkHotelSetupCreationCredential,
      proveProperty: property.checkHotelSetupPropertyCredential,
    });
    console.log(JSON.stringify(receipt));
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
    console.error(
      JSON.stringify({ status: "FAIL", code: "hotel_setup_automatic_inspection_required" }),
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A hung proof/publication must not outlive the bounded operational pass. Durable
  // assignment/prefix detection makes any interrupted attempt inspection-only.
  const timer = setTimeout(() => {
    console.error(
      JSON.stringify({
        status: "FAIL",
        code: "hotel_setup_automatic_deadline",
        ...(helperPhase ? { helper: helperPhase } : {}),
      }),
    );
    process.exit(1);
  }, 170_000);
  try {
    process.exitCode = await runHotelSetupAutomaticProvisioning();
  } finally {
    clearTimeout(timer);
  }
}
