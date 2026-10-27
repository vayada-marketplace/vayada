import type { ChannexManagementConfig } from "./config.js";

export type ChannexManagementDatabaseRouting = Readonly<{
  bookingRevisionStore?: string;
  plans?: string;
  reconciliation?: string;
  availabilityInventory?: string;
  workerStore?: string;
  scheduler?: Readonly<{
    connectionString: string;
    /** The staging canary's single property. */
    propertyId?: string;
    /** VAY-2108 D7: the claimed scope's owned hotels (exact list, may be empty). */
    propertyIds?: readonly string[];
  }>;
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
  // D7: with ARI and provisioning on, the worker also serves the owned hotels' ARI and offers.
  const claimedAri =
    claimed &&
    input.config.capabilityModes.ariSync === "mutating" &&
    input.config.capabilityModes.provisioning === "mutating";
  const managementEnabled =
    input.commandsMutating &&
    (!claimed || input.config.capabilityModes.connection === "mutating" || claimedAri);
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
        : managementEnabled && claimedAri
          ? Object.freeze({
              connectionString,
              propertyIds: Object.freeze([...(input.config.ownedPropertyIds ?? [])]),
            })
          : undefined,
  });
}
