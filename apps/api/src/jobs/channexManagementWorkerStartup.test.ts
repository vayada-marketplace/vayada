import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannexManagementConfig } from "../config.js";
import { preflightChannexManagementWorker } from "./channexManagementWorkerStartup.js";

const config: ChannexManagementConfig = {
  apiBaseUrl: "https://staging.channex.io",
  workerDatabaseUrl: "postgresql://fixture@invalid/test",
  workerEnabled: true,
  bookingMutationOwner: "legacy",
  stagingRestrictionsPropertyId: "fixture",
  capabilityModes: {
    connection: "observe_only",
    provisioning: "observe_only",
    ariSync: "mutating",
    bookingSync: "observe_only",
    markups: "observe_only",
    messaging: "observe_only",
    reviews: "observe_only",
    iframe: "observe_only",
  },
};
// VAY-2055: production connection-only scope; reviews stay independently mutating.
const connectionOnly: ChannexManagementConfig = {
  apiBaseUrl: "https://app.channex.io",
  workerDatabaseUrl: "postgresql://fixture@invalid/test",
  workerEnabled: true,
  bookingMutationOwner: "legacy",
  capabilityModes: {
    connection: "mutating",
    provisioning: "observe_only",
    ariSync: "observe_only",
    bookingSync: "observe_only",
    markups: "observe_only",
    messaging: "observe_only",
    reviews: "mutating",
    iframe: "observe_only",
  },
};
afterEach(() => vi.restoreAllMocks());
describe("Channex worker startup", () => {
  it("opens no connection while paused", async () => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await preflightChannexManagementWorker({ ...config, workerEnabled: false }, true);
    expect(connect).not.toHaveBeenCalled();
  });
  it("opens no worker credential for observe-only or unrelated management modes", async () => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await preflightChannexManagementWorker(config, false);
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    { stagingRestrictionsPropertyId: undefined },
    { apiBaseUrl: "https://app.channex.io" },
    { stagingMealsEnabled: true },
    { capabilityModes: { ...config.capabilityModes, bookingSync: "mutating" as const } },
  ])("rejects unsupported worker scope before connecting: %j", async (override) => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(
      preflightChannexManagementWorker({ ...config, ...override }, true),
    ).rejects.toThrow("channex_worker_scope_unsupported");
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    { workerDatabaseUrl: undefined },
    { apiBaseUrl: "https://example.invalid" },
    { stagingInventoryEnabled: true },
    { stagingNoShowEnabled: true },
    { capabilityModes: { ...connectionOnly.capabilityModes, ariSync: "mutating" as const } },
    { capabilityModes: { ...connectionOnly.capabilityModes, provisioning: "mutating" as const } },
    { capabilityModes: { ...connectionOnly.capabilityModes, bookingSync: "mutating" as const } },
    { capabilityModes: { ...connectionOnly.capabilityModes, markups: "mutating" as const } },
    { capabilityModes: { ...connectionOnly.capabilityModes, messaging: "mutating" as const } },
  ])("rejects a widened connection-only scope before connecting: %j", async (override) => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(
      preflightChannexManagementWorker({ ...connectionOnly, ...override }, true),
    ).rejects.toThrow("channex_worker_scope_unsupported");
    expect(connect).not.toHaveBeenCalled();
  });
  // VAY-2108: claimed booking sync runs on the API login; only its connection part needs the worker.
  const claimed: ChannexManagementConfig = {
    ...connectionOnly,
    scope: "claimed",
    ownedPropertyIds: [],
    bookingMutationOwner: "target",
    capabilityModes: { ...connectionOnly.capabilityModes, bookingSync: "mutating" },
  };
  it("opens no worker credential for claimed booking sync without connection", async () => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await preflightChannexManagementWorker(
      { ...claimed, capabilityModes: { ...claimed.capabilityModes, connection: "observe_only" } },
      true,
    );
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    { capabilityModes: { ...claimed.capabilityModes, ariSync: "mutating" as const } },
    { capabilityModes: { ...claimed.capabilityModes, messaging: "mutating" as const } },
    { stagingRestrictionsPropertyId: "fixture" },
  ])("rejects a widened claimed scope before connecting: %j", async (override) => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(
      preflightChannexManagementWorker({ ...claimed, ...override }, true),
    ).rejects.toThrow("channex_worker_scope_unsupported");
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([connectionOnly, claimed])(
    "connects with the worker credential for the connection scope (%#)",
    async (scope) => {
      const connect = vi
        .spyOn(pg.Client.prototype, "connect")
        .mockRejectedValue(new Error("fixture_connect"));
      await expect(preflightChannexManagementWorker(scope, true)).rejects.toThrow(
        "fixture_connect",
      );
      expect(connect).toHaveBeenCalledTimes(1);
    },
  );
  it("connects with the worker credential for the connection-only scope", async () => {
    const connect = vi
      .spyOn(pg.Client.prototype, "connect")
      .mockRejectedValue(new Error("fixture_connect"));
    await expect(preflightChannexManagementWorker(connectionOnly, true)).rejects.toThrow(
      "fixture_connect",
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
