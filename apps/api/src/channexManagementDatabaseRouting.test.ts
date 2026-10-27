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

  it("keeps claimed booking sync off the worker login", () => {
    const claimed = (connection: "mutating" | "observe_only") =>
      resolveChannexManagementDatabaseRouting({
        config: config({
          scope: "claimed",
          ownedPropertyIds: [],
          capabilityModes: {
            ...config().capabilityModes,
            provisioning: "observe_only",
            ariSync: "observe_only",
            bookingSync: "mutating",
            connection,
          },
        }),
        commandsMutating: true,
      });
    expect(claimed("observe_only")).toEqual({
      bookingRevisionStore: undefined,
      plans: undefined,
      reconciliation: undefined,
      availabilityInventory: undefined,
      workerStore: undefined,
      scheduler: undefined,
    });
    expect(claimed("mutating")).toMatchObject({
      bookingRevisionStore: undefined,
      workerStore: "postgresql://channex_worker@db/app",
    });
  });

  it("routes the claimed ARI scope's management consumers and schedules the owned hotels", () => {
    const owned = ["29f39aae-0000-4000-8000-000000000001"];
    const routing = resolveChannexManagementDatabaseRouting({
      config: config({
        scope: "claimed",
        ownedPropertyIds: owned,
        capabilityModes: {
          ...config().capabilityModes,
          connection: "observe_only",
          provisioning: "mutating",
          ariSync: "mutating",
          bookingSync: "mutating",
        },
      }),
      commandsMutating: true,
    });
    expect(routing).toEqual({
      bookingRevisionStore: undefined,
      plans: "postgresql://channex_worker@db/app",
      reconciliation: "postgresql://channex_worker@db/app",
      availabilityInventory: "postgresql://channex_worker@db/app",
      workerStore: "postgresql://channex_worker@db/app",
      scheduler: { connectionString: "postgresql://channex_worker@db/app", propertyIds: owned },
    });
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
