import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";

/** One request stays well below CloudFront's 3,000 paths in progress per distribution. */
export const MAX_MEDIA_INVALIDATION_PATHS = 1000;

const DISTRIBUTION_ID = /^E[A-Z0-9]{5,30}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PUBLIC_KEY_PREFIX = "public/";
const CLOUDFRONT_CONNECTION_TIMEOUT_MS = 5_000;
const CLOUDFRONT_REQUEST_TIMEOUT_MS = 30_000;

type CloudFrontSender = Pick<CloudFrontClient, "send">;

export type PlatformMediaCdnInvalidator = {
  /**
   * Clears the CDN copies of public objects already deleted from storage (VAY-2272). The caller
   * reference is derived from the paths, so retrying the same batch returns the same
   * invalidation instead of starting a second one.
   */
  invalidatePublicObjects(storageKeys: readonly string[]): Promise<{ invalidationId: string }>;
  close(): void;
};

/** The CDN path of a public object; the distribution's origin path is `/public`. */
export function publicMediaCdnPath(storageKey: string): string {
  if (!storageKey.startsWith(PUBLIC_KEY_PREFIX)) {
    throw new Error("Only public media objects are served by the CDN");
  }
  const segments = storageKey.slice(PUBLIC_KEY_PREFIX.length).split("/");
  if (!segments.every((segment) => SAFE_SEGMENT.test(segment))) {
    throw new Error("Public media key has an unsafe path segment");
  }
  return `/${segments.join("/")}`;
}

export function createCloudFrontMediaInvalidator(options: {
  distributionId: string;
  client?: CloudFrontSender;
}): PlatformMediaCdnInvalidator {
  if (!DISTRIBUTION_ID.test(options.distributionId)) {
    throw new Error("PLATFORM_MEDIA_CDN_DISTRIBUTION_ID is not a CloudFront distribution ID");
  }
  const owned = !options.client;
  const client =
    options.client ??
    new CloudFrontClient({
      // CloudFront has one global endpoint, signed for us-east-1 whatever the task's region.
      region: "us-east-1",
      requestHandler: NodeHttpHandler.create({
        connectionTimeout: CLOUDFRONT_CONNECTION_TIMEOUT_MS,
        requestTimeout: CLOUDFRONT_REQUEST_TIMEOUT_MS,
        socketTimeout: CLOUDFRONT_REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      }),
    });

  return {
    async invalidatePublicObjects(storageKeys) {
      const paths = [...new Set(storageKeys.map(publicMediaCdnPath))].sort();
      if (paths.length === 0) throw new Error("No public media paths to invalidate");
      if (paths.length > MAX_MEDIA_INVALIDATION_PATHS) {
        throw new Error(`At most ${MAX_MEDIA_INVALIDATION_PATHS} paths per media invalidation`);
      }
      const digest = createHash("sha256").update(paths.join("\n")).digest("hex");
      const output = await client.send(
        new CreateInvalidationCommand({
          DistributionId: options.distributionId,
          InvalidationBatch: {
            CallerReference: `vayada-media-${digest}`,
            Paths: { Quantity: paths.length, Items: paths },
          },
        }),
      );
      const invalidationId = output.Invalidation?.Id;
      if (!invalidationId) throw new Error("CloudFront returned no invalidation ID");
      return { invalidationId };
    },
    close() {
      if (owned) (client as CloudFrontClient).destroy();
    },
  };
}
