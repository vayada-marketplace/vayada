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
  const managementEnabled = input.commandsMutating;
  return Object.freeze({
    bookingRevisionStore:
      input.config.capabilityModes.bookingSync === "mutating" ? connectionString : undefined,
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
