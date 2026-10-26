import { projectPropertyPublicProfile } from "./propertyPublicProfileProjection.js";
import type {
  ApprovedPublicProfileImageRepository,
  PlatformMediaRoutesOptions,
} from "../routes/platformMedia.js";
import {
  createPgPlatformMediaCleanupStore,
  DEFAULT_PLATFORM_MEDIA_CLEANUP_RUNS,
  type PlatformMediaCleanupRunName,
} from "../jobs/platformMediaCleanup.js";
import { createPgS3PropertyMediaCommandRepository } from "../domains/propertyMediaCommandRepository.js";
import type { PlatformMediaServingConfig } from "./mediaServing.js";
import { createCloudFrontMediaInvalidator } from "./platformMediaCdnInvalidation.js";
import { createPgPlatformMediaRepository } from "./platformMediaRepository.js";
import {
  createS3PlatformMediaAdapter,
  type PlatformMediaInboundAttachmentWriter,
  type PlatformMediaPrivateDownloadSigner,
  type PlatformMediaPrivateObjectReader,
} from "./platformMediaS3.js";

export type PlatformMediaRuntimeInput = {
  auth?: unknown;
  allowedOrigins?: string[];
  pmsInboxEnabled: boolean;
  targetDatabaseUrl: string;
  platformMediaServing?: PlatformMediaServingConfig;
  retiredPurge?: { cdnDistributionId: string };
};

export type PlatformMediaRuntimeFactories = {
  createRepository: typeof createPgPlatformMediaRepository;
  createAdapter: typeof createS3PlatformMediaAdapter;
  createCleanupStore: typeof createPgPlatformMediaCleanupStore;
  createPropertyMediaCommands: typeof createPgS3PropertyMediaCommandRepository;
  createCdnInvalidator: typeof createCloudFrontMediaInvalidator;
};

export type PlatformMediaRuntime = {
  profileMediaRepository: ApprovedPublicProfileImageRepository;
  privateDownloads: {
    signer: PlatformMediaPrivateDownloadSigner;
    reader: PlatformMediaPrivateObjectReader;
    serving: PlatformMediaServingConfig;
  };
  inboundAttachments: PlatformMediaInboundAttachmentWriter;
  cleanupStore: ReturnType<typeof createPgPlatformMediaCleanupStore>;
  cleanupRuns: readonly PlatformMediaCleanupRunName[];
  propertyMediaCommands: ReturnType<typeof createPgS3PropertyMediaCommandRepository>;
  routes: PlatformMediaRoutesOptions;
};

const productionFactories: PlatformMediaRuntimeFactories = {
  createRepository: createPgPlatformMediaRepository,
  createAdapter: createS3PlatformMediaAdapter,
  createCleanupStore: createPgPlatformMediaCleanupStore,
  createPropertyMediaCommands: createPgS3PropertyMediaCommandRepository,
  createCdnInvalidator: createCloudFrontMediaInvalidator,
};

export function composePlatformMediaRuntime(
  input: PlatformMediaRuntimeInput,
  factories: PlatformMediaRuntimeFactories = productionFactories,
): PlatformMediaRuntime | undefined {
  if (!input.auth || !input.platformMediaServing) return undefined;

  const repository = factories.createRepository({
    connectionString: input.targetDatabaseUrl,
    publicCdnBaseUrl: input.platformMediaServing.cdnBaseUrl,
    mediaPathPrefix: input.platformMediaServing.publicPathPrefix,
  });
  const adapter = factories.createAdapter({
    bucketName: input.platformMediaServing.bucketName,
    cdnBaseUrl: input.platformMediaServing.cdnBaseUrl,
    publicPathPrefix: input.platformMediaServing.publicPathPrefix,
    publicCacheControl: input.platformMediaServing.publicCacheControl,
  });
  const cleanupStore = factories.createCleanupStore({
    connectionString: input.targetDatabaseUrl,
    objectDeleter: adapter,
    ...(input.retiredPurge
      ? {
          cdnInvalidator: factories.createCdnInvalidator({
            distributionId: input.retiredPurge.cdnDistributionId,
          }),
        }
      : {}),
  });
  const propertyMediaCommands = factories.createPropertyMediaCommands({
    connectionString: input.targetDatabaseUrl,
    serving: input.platformMediaServing,
    syncReadModels: projectPropertyPublicProfile,
  });
  const enabledPurposes: PlatformMediaRoutesOptions["enabledPurposes"] = [
    "identity.user.profile_image",
    "booking.header_logo",
    "booking.addon.image",
    "property.hero_image",
    "property.gallery_image",
    "property.logo",
    "pms.room_type.media",
    "finance.expense.receipt",
    ...(input.pmsInboxEnabled ? (["pms.messaging.attachment"] as const) : []),
  ];

  return {
    profileMediaRepository: repository,
    privateDownloads: { signer: adapter, reader: adapter, serving: input.platformMediaServing },
    inboundAttachments: adapter,
    cleanupStore,
    cleanupRuns: input.retiredPurge
      ? [...DEFAULT_PLATFORM_MEDIA_CLEANUP_RUNS, "retiredMarketplacePurge"]
      : DEFAULT_PLATFORM_MEDIA_CLEANUP_RUNS,
    propertyMediaCommands,
    routes: {
      repository,
      signer: adapter,
      targetResolver: repository,
      finalizer: adapter,
      enabledPurposes,
      bucketName: input.platformMediaServing.bucketName,
      mediaPathPrefix: input.platformMediaServing.publicPathPrefix,
      allowedOrigins: input.allowedOrigins ?? [],
    },
  };
}
