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
});
