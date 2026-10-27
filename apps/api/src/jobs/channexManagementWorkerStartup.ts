import pg from "pg";
import { channexConnectionOnlyScope, type ChannexManagementConfig } from "../config.js";
import { assertChannexManagementWorkerBoundary } from "./channexManagementWorkerBoundary.js";
import { CHANNEX_MANAGEMENT_WORKER_ROLE } from "./channexManagementWorkerPrivileges.js";

/** Runs before any management consumer or scheduler is constructed. */
export async function preflightChannexManagementWorker(
  config: ChannexManagementConfig,
  commandsMutating: boolean,
) {
  if (!config.workerEnabled || !commandsMutating) return;
  const connectionOnly = channexConnectionOnlyScope(config);
  if (!config.workerDatabaseUrl || !(connectionOnly || stagingCanaryScope(config)))
    throw new Error("channex_worker_scope_unsupported");
  const client = new pg.Client({
    connectionString: config.workerDatabaseUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  try {
    await client.connect();
    await client.query("SET search_path TO pg_catalog");
    const login = (await client.query("SELECT current_user,session_user")).rows[0];
    if (
      login.current_user !== CHANNEX_MANAGEMENT_WORKER_ROLE ||
      login.session_user !== CHANNEX_MANAGEMENT_WORKER_ROLE
    )
      throw new Error("channex_worker_login_mismatch");
    await assertChannexManagementWorkerBoundary(
      client,
      connectionOnly
        ? { connectionScope: true }
        : { propertyId: config.stagingRestrictionsPropertyId },
    );
  } finally {
    await client.end();
  }
}

/** VAY-2041: the single staging ARI canary (optionally with published offers). */
function stagingCanaryScope(config: ChannexManagementConfig) {
  return (
    !!config.stagingRestrictionsPropertyId &&
    config.apiBaseUrl === "https://staging.channex.io" &&
    !config.stagingMealsEnabled &&
    !config.stagingNoShowEnabled &&
    !Object.entries(config.capabilityModes).some(
      ([name, mode]) =>
        mode === "mutating" &&
        name !== "ariSync" &&
        !(name === "provisioning" && config.stagingPublishedOffersEnabled),
    )
  );
}
