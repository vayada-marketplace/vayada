import type { ChannexManagementConfig } from "./config.js";

export type ChannexManagementDatabaseRouting = Readonly<{
  bookingRevisionStore?: string;
  plans?: string;
  reconciliation?: string;
  availabilityInventory?: string;
  workerStore?: string;
  scheduler?: Readonly<{ connectionString: string; propertyId: string }>;
}>;

export function resolveChannexManagementDatabaseRouting(input: {
  config: ChannexManagementConfig;
  commandsMutating: boolean;
}): ChannexManagementDatabaseRouting {
  const connectionString = input.config.workerDatabaseUrl;
  if (!input.config.workerEnabled || !connectionString) return Object.freeze({});
  // VAY-2108: the claimed scope pulls bookings on the API login and runs the management worker
  // only for connection (enable); it never routes booking revisions through the worker login.
  const claimed = input.config.scope === "claimed";
  const managementEnabled =
    input.commandsMutating && (!claimed || input.config.capabilityModes.connection === "mutating");
  return Object.freeze({
    bookingRevisionStore:
      input.config.capabilityModes.bookingSync === "mutating" && !claimed
        ? connectionString
        : undefined,
    plans: managementEnabled ? connectionString : undefined,
    reconciliation:
      managementEnabled && input.config.capabilityModes.ariSync === "mutating"
        ? connectionString
        : undefined,
    availabilityInventory:
      managementEnabled && input.config.capabilityModes.ariSync === "mutating"
        ? connectionString
        : undefined,
    workerStore: managementEnabled ? connectionString : undefined,
    scheduler:
      managementEnabled &&
      input.config.stagingInventoryEnabled &&
      input.config.stagingRestrictionsPropertyId
        ? Object.freeze({
            connectionString,
            propertyId: input.config.stagingRestrictionsPropertyId,
          })
        : undefined,
  });
}
