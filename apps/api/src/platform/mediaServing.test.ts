import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLIC_MEDIA_CACHE_CONTROL,
  buildPublicMediaServingDescriptor,
  createPrivateDownloadPolicy,
  createPlatformMediaServingConfig,
  loadPlatformMediaServingConfig,
  planPublicMediaReplacement,
  type PlatformMediaServingConfig,
} from "./mediaServing.js";

const servingConfig: PlatformMediaServingConfig = createPlatformMediaServingConfig({
  bucketName: "vayada-media-production",
  cdnBaseUrl: "https://cdn.vayada.com/",
  cdnOriginHost: "vayada-media-production.s3.us-east-1.amazonaws.com",
  publicPathPrefix: "media",
  publicCacheControl: DEFAULT_PUBLIC_MEDIA_CACHE_CONTROL,
  privateDownloadTtlSeconds: 300,
  privateDownloadMaxTtlSeconds: 900,
});

describe("platform media serving policy", () => {
  it("loads the optional bucket and CDN env contract when fully configured", () => {
    expect(
      loadPlatformMediaServingConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-staging",
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.staging.vayada.com/",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-staging.s3.us-east-1.amazonaws.com",
        PLATFORM_MEDIA_PUBLIC_PATH_PREFIX: "/media/",
        PLATFORM_MEDIA_PRIVATE_DOWNLOAD_TTL_SECONDS: "120",
        PLATFORM_MEDIA_PRIVATE_DOWNLOAD_MAX_TTL_SECONDS: "600",
      }),
    ).toEqual({
      bucketName: "vayada-media-staging",
      cdnBaseUrl: "https://cdn.staging.vayada.com",
      cdnOriginHost: "vayada-media-staging.s3.us-east-1.amazonaws.com",
      publicPathPrefix: "media",
      publicCacheControl: DEFAULT_PUBLIC_MEDIA_CACHE_CONTROL,
      privateDownloadTtlSeconds: 120,
      privateDownloadMaxTtlSeconds: 600,
    });
  });

  it("keeps media serving inactive until the cutover env contract is complete", () => {
    expect(loadPlatformMediaServingConfig({})).toBeUndefined();
    expect(() =>
      loadPlatformMediaServingConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-production",
      }),
    ).toThrow("Incomplete platform media serving config");
  });

  it("rejects unsafe CDN origins and direct origin exposure", () => {
    expect(() =>
      loadPlatformMediaServingConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-production",
        PLATFORM_MEDIA_CDN_BASE_URL: "http://cdn.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-production.s3.us-east-1.amazonaws.com",
      }),
    ).toThrow("PLATFORM_MEDIA_CDN_BASE_URL must be an HTTPS origin");

    expect(() =>
      loadPlatformMediaServingConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-production",
        PLATFORM_MEDIA_CDN_BASE_URL: "https://vayada-media-production.s3.us-east-1.amazonaws.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-production.s3.us-east-1.amazonaws.com",
      }),
    ).toThrow("must not point directly at the CDN origin host");
  });

  it("rejects public path prefixes that collide with storage namespaces", () => {
    expect(() =>
      loadPlatformMediaServingConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-production",
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-production.s3.us-east-1.amazonaws.com",
        PLATFORM_MEDIA_PUBLIC_PATH_PREFIX: "private/uploads",
      }),
    ).toThrow("PLATFORM_MEDIA_PUBLIC_PATH_PREFIX must not use a reserved storage namespace");
  });

  it("requires public media cache-control to be long-lived and immutable", () => {
    expect(() =>
      loadPlatformMediaServingConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-production",
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-production.s3.us-east-1.amazonaws.com",
        PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL: "private, no-store",
      }),
    ).toThrow("PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL must be public cacheable");

    expect(() =>
      loadPlatformMediaServingConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-production",
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-production.s3.us-east-1.amazonaws.com",
        PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL: "public, max-age=60",
      }),
    ).toThrow("PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL must include immutable");
  });

  it("builds opaque immutable public CDN URLs only for active approved public variants", () => {
    expect(
      buildPublicMediaServingDescriptor(servingConfig, {
        mediaId: "media_01HX",
        variantName: "large",
        version: "sha256-abc123",
        fileExtension: "WEBP",
        visibility: "public",
        status: "active",
        publicApproved: true,
      }),
    ).toEqual({
      url: "https://cdn.vayada.com/media/media_01HX/large/sha256-abc123.webp",
      cacheControl: "public, max-age=31536000, immutable",
      invalidationRequired: false,
    });

    expect(() =>
      buildPublicMediaServingDescriptor(servingConfig, {
        mediaId: "media_01HX",
        variantName: "large",
        version: "sha256-abc123",
        fileExtension: "webp",
        visibility: "private",
        status: "active",
        publicApproved: true,
      }),
    ).toThrow("Private media must not be exposed through public CDN URLs");

    expect(() =>
      buildPublicMediaServingDescriptor(servingConfig, {
        mediaId: "media_01HX",
        variantName: "large",
        version: "sha256-abc123",
        fileExtension: "webp",
        visibility: "public",
        status: "active",
        publicApproved: false,
      }),
    ).toThrow("Public CDN URLs require domain public approval");
  });

  it("keeps private downloads on short-lived signed object policies", () => {
    expect(
      createPrivateDownloadPolicy(
        servingConfig,
        {
          bucketName: "vayada-media-production",
          storageKey:
            "private/pms/properties/property_123/messages/thread_456/media_789/invoice.pdf",
          visibility: "private",
          status: "active",
          originalFilename: 'invoice "june".pdf',
          contentType: "application/pdf",
        },
        { ttlSeconds: 180 },
      ),
    ).toEqual({
      bucketName: "vayada-media-production",
      storageKey: "private/pms/properties/property_123/messages/thread_456/media_789/invoice.pdf",
      method: "GET",
      expiresInSeconds: 180,
      cacheControl: "private, no-store",
      responseContentDisposition: 'attachment; filename="invoice _june_.pdf"',
      responseContentType: "application/pdf",
    });
  });

  it("allows a stricter private download TTL ceiling when the signed TTL also fits", () => {
    expect(
      loadPlatformMediaServingConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-staging",
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.staging.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-staging.s3.us-east-1.amazonaws.com",
        PLATFORM_MEDIA_PRIVATE_DOWNLOAD_TTL_SECONDS: "60",
        PLATFORM_MEDIA_PRIVATE_DOWNLOAD_MAX_TTL_SECONDS: "120",
      }),
    ).toMatchObject({
      privateDownloadTtlSeconds: 60,
      privateDownloadMaxTtlSeconds: 120,
    });
  });

  it("rejects public objects and public storage keys for private download policies", () => {
    expect(() =>
      createPrivateDownloadPolicy(servingConfig, {
        bucketName: "vayada-media-production",
        storageKey: "public/properties/property_123/media_789/large.webp",
        visibility: "private",
        status: "active",
      }),
    ).toThrow("Private download storage keys must use the private/ namespace");

    expect(() =>
      createPrivateDownloadPolicy(servingConfig, {
        bucketName: "vayada-media-production",
        storageKey: "private/marketplace/collaborations/collab_123/media_789/image.gif",
        visibility: "public",
        status: "active",
      }),
    ).toThrow("Only private media objects use signed private download policies");
  });

  it("requires replacements to publish a new versioned URL instead of overwriting cache", () => {
    const previous = buildPublicMediaServingDescriptor(servingConfig, {
      mediaId: "media_01HX",
      variantName: "large",
      version: "sha256-old",
      fileExtension: "webp",
      visibility: "public",
      status: "active",
      publicApproved: true,
    });
    const next = buildPublicMediaServingDescriptor(servingConfig, {
      mediaId: "media_02HY",
      variantName: "large",
      version: "sha256-new",
      fileExtension: "webp",
      visibility: "public",
      status: "active",
      publicApproved: true,
    });

    expect(planPublicMediaReplacement(previous, next)).toEqual({
      publishUrl: next.url,
      retireUrl: previous.url,
      invalidateRetiredUrl: false,
      reason: "immutable_versioned_urls",
    });
    expect(() => planPublicMediaReplacement(previous, previous)).toThrow(
      "Replacing public media must publish a new immutable versioned URL",
    );
  });
});
