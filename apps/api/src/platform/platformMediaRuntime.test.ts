import { describe, expect, it, vi } from "vitest";

import {
  createPgPlatformMediaCleanupStore,
  DEFAULT_PLATFORM_MEDIA_CLEANUP_RUNS,
} from "../jobs/platformMediaCleanup.js";
import { createPgS3PropertyMediaCommandRepository } from "../domains/propertyMediaCommandRepository.js";
import type { PlatformMediaServingConfig } from "./mediaServing.js";
import { createCloudFrontMediaInvalidator } from "./platformMediaCdnInvalidation.js";
import { createPgPlatformMediaRepository } from "./platformMediaRepository.js";
import {
  composePlatformMediaRuntime,
  type PlatformMediaRuntimeFactories,
  type PlatformMediaRuntimeInput,
} from "./platformMediaRuntime.js";
import { createS3PlatformMediaAdapter } from "./platformMediaS3.js";

const platformMediaServing: PlatformMediaServingConfig = {
  bucketName: "vayada-media-production",
  cdnBaseUrl: "https://cdn.vayada.com",
  cdnOriginHost: "vayada-media-production.s3.us-east-1.amazonaws.com",
  publicPathPrefix: "profile-media",
  publicCacheControl: "public, max-age=31536000, immutable",
  privateDownloadTtlSeconds: 300,
  privateDownloadMaxTtlSeconds: 900,
};

const completeInput: PlatformMediaRuntimeInput = {
  auth: {},
  pmsInboxEnabled: true,
  targetDatabaseUrl: "postgresql://target-db",
  platformMediaServing,
  allowedOrigins: ["https://marketplace.vayada.com"],
};

describe("platform media runtime composition", () => {
  it("keeps the runtime dark until auth and media serving are configured", () => {
    for (const missing of ["auth", "platformMediaServing"] as const) {
      const { factories } = fakeFactories();

      expect(
        composePlatformMediaRuntime({ ...completeInput, [missing]: undefined }, factories),
      ).toBeUndefined();
      expect(factories.createRepository).not.toHaveBeenCalled();
      expect(factories.createAdapter).not.toHaveBeenCalled();
      expect(factories.createCleanupStore).not.toHaveBeenCalled();
      expect(factories.createPropertyMediaCommands).not.toHaveBeenCalled();
    }
  });

  it("shares production resources across profile validation and the restricted routes", () => {
    const { repository, adapter, cleanupStore, propertyMediaCommands, factories } = fakeFactories();
    const runtime = composePlatformMediaRuntime(completeInput, factories);
    if (!runtime) throw new Error("Expected complete media configuration to compose a runtime");

    expect(factories.createRepository).toHaveBeenCalledOnce();
    expect(factories.createRepository).toHaveBeenCalledWith({
      connectionString: "postgresql://target-db",
      publicCdnBaseUrl: "https://cdn.vayada.com",
      mediaPathPrefix: "profile-media",
    });
    expect(factories.createAdapter).toHaveBeenCalledOnce();
    expect(factories.createAdapter).toHaveBeenCalledWith({
      bucketName: "vayada-media-production",
      cdnBaseUrl: "https://cdn.vayada.com",
      publicPathPrefix: "profile-media",
      publicCacheControl: "public, max-age=31536000, immutable",
    });
    expect(factories.createCleanupStore).toHaveBeenCalledOnce();
    expect(factories.createCleanupStore).toHaveBeenCalledWith({
      connectionString: "postgresql://target-db",
      objectDeleter: adapter,
    });
    expect(factories.createPropertyMediaCommands).toHaveBeenCalledWith({
      connectionString: "postgresql://target-db",
      serving: platformMediaServing,
      syncReadModels: expect.any(Function),
    });

    expect(runtime.profileMediaRepository).toBe(repository);
    expect(runtime.cleanupStore).toBe(cleanupStore);
    expect(runtime.propertyMediaCommands).toBe(propertyMediaCommands);
    expect(runtime.routes.mediaPathPrefix).toBe("profile-media");
    expect(runtime.privateDownloads).toEqual({
      signer: adapter,
      reader: adapter,
      serving: platformMediaServing,
    });
    expect(runtime.inboundAttachments).toBe(adapter);
    expect(runtime.routes.repository).toBe(repository);
    expect(runtime.routes.signer).toBe(adapter);
    expect(runtime.routes.finalizer).toBe(adapter);
    expect(runtime.routes.targetResolver).toBe(repository);
    expect(runtime.routes).toMatchObject({
      enabledPurposes: [
        "identity.user.profile_image",
        "booking.header_logo",
        "booking.addon.image",
        "property.hero_image",
        "property.gallery_image",
        "property.logo",
        "pms.room_type.media",
        "finance.expense.receipt",
        "pms.messaging.attachment",
      ],
      bucketName: "vayada-media-production",
      allowedOrigins: ["https://marketplace.vayada.com"],
    });
  });

  it("adds the retired-media purge and its CDN invalidator only when configured (VAY-2272)", () => {
    const { adapter, cdnInvalidator, factories } = fakeFactories();

    const off = composePlatformMediaRuntime(completeInput, factories);
    expect(off?.cleanupRuns).toEqual(DEFAULT_PLATFORM_MEDIA_CLEANUP_RUNS);
    expect(factories.createCdnInvalidator).not.toHaveBeenCalled();

    const on = composePlatformMediaRuntime(
      { ...completeInput, retiredPurge: { cdnDistributionId: "E2EXAMPLE12345" } },
      factories,
    );
    expect(factories.createCdnInvalidator).toHaveBeenCalledWith({
      distributionId: "E2EXAMPLE12345",
    });
    expect(factories.createCleanupStore).toHaveBeenLastCalledWith({
      connectionString: "postgresql://target-db",
      objectDeleter: adapter,
      cdnInvalidator,
    });
    expect(on?.cleanupRuns).toEqual([
      ...DEFAULT_PLATFORM_MEDIA_CLEANUP_RUNS,
      "retiredMarketplacePurge",
    ]);
  });

  it("keeps Inbox attachment mutations disabled outside the target PMS runtime", () => {
    const runtime = composePlatformMediaRuntime(
      { ...completeInput, pmsInboxEnabled: false },
      fakeFactories().factories,
    );
    expect(runtime?.routes.enabledPurposes).not.toContain("pms.messaging.attachment");
  });
});

function fakeFactories() {
  const repository = {} as ReturnType<typeof createPgPlatformMediaRepository>;
  const adapter = {} as ReturnType<typeof createS3PlatformMediaAdapter>;
  const cleanupStore = {} as ReturnType<typeof createPgPlatformMediaCleanupStore>;
  const propertyMediaCommands = {} as ReturnType<typeof createPgS3PropertyMediaCommandRepository>;
  const cdnInvalidator = {} as ReturnType<typeof createCloudFrontMediaInvalidator>;
  const factories: PlatformMediaRuntimeFactories = {
    createRepository: vi.fn(() => repository),
    createAdapter: vi.fn(() => adapter),
    createCleanupStore: vi.fn(() => cleanupStore),
    createPropertyMediaCommands: vi.fn(() => propertyMediaCommands),
    createCdnInvalidator: vi.fn(() => cdnInvalidator),
  };
  return {
    repository,
    adapter,
    cleanupStore,
    propertyMediaCommands,
    cdnInvalidator,
    factories,
  };
}
