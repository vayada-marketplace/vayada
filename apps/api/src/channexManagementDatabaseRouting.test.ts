import { describe, expect, it } from "vitest";

import type { ChannexManagementConfig } from "./config.js";
import { resolveChannexManagementDatabaseRouting } from "./channexManagementDatabaseRouting.js";

const config = (overrides: Partial<ChannexManagementConfig> = {}): ChannexManagementConfig => ({
  apiBaseUrl: "https://staging.channex.io",
  apiKey: "test",
  workerDatabaseUrl: "postgresql://channex_worker@db/app",
  bookingMutationOwner: "legacy",
  workerEnabled: true,
  capabilityModes: {
    connection: "observe_only",
    provisioning: "mutating",
    ariSync: "mutating",
    bookingSync: "observe_only",
    markups: "observe_only",
    messaging: "observe_only",
    reviews: "observe_only",
    iframe: "observe_only",
  },
  ...overrides,
});

describe("Channex management database routing", () => {
  it("opens no management database consumer while paused", () => {
    expect(
      resolveChannexManagementDatabaseRouting({
        config: config({
          workerEnabled: false,
          stagingInventoryEnabled: true,
          stagingRestrictionsPropertyId: "65f6b2fc-c783-4963-9d6b-a85f82319769",
        }),
        commandsMutating: true,
      }),
    ).toEqual({});
  });

  it("routes every selected-offer management consumer to the dedicated credential", () => {
    const connectionString = "postgresql://channex_worker@db/app";
    expect(
      resolveChannexManagementDatabaseRouting({
        config: config({
          workerDatabaseUrl: connectionString,
          stagingInventoryEnabled: true,
          stagingRestrictionsPropertyId: "65f6b2fc-c783-4963-9d6b-a85f82319769",
        }),
        commandsMutating: true,
      }),
    ).toEqual({
      bookingRevisionStore: undefined,
      plans: connectionString,
      reconciliation: connectionString,
      availabilityInventory: connectionString,
      workerStore: connectionString,
      scheduler: {
        connectionString,
        propertyId: "65f6b2fc-c783-4963-9d6b-a85f82319769",
      },
    });
  });
});
