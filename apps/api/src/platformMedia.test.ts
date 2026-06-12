import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type Product,
  type ResourceRelationship,
  type ResourceType,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  createDeterministicPlatformMediaFinalizer,
  createDeterministicPlatformMediaUploadSigner,
  createInMemoryPlatformMediaRepository,
  type PlatformMediaObjectRecord,
  type PlatformMediaRepository,
  type PlatformMediaTargetResolver,
  type PlatformMediaUploadFinalizer,
} from "./routes/platformMedia.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "workos_media_user",
  workosOrgId: "workos_media_org",
  sessionId: "session_media",
  expiresAt: futureExpiry,
};

const uploadContractCases = JSON.parse(
  readFileSync(
    new URL("../../../engineering/fixtures/platform-media-upload/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: Array<{
    caseId: string;
    request: {
      path: string;
      method: "POST";
      body: Record<string, unknown>;
    };
    finalize?: {
      files: Array<Record<string, unknown>>;
    };
    expected: {
      status: number;
      errorCode?: string;
      requestedVisibility?: string;
      effectiveVisibility?: string;
      finalizeStatus?: number;
      mediaObjectCount?: number;
      mediaObject?: Record<string, string>;
      requiredVariants?: string[];
      sideEffects?: string[];
    };
  }>;
};

const propertyGalleryCase = contractCase("property-gallery-upload-session");
const propertyGalleryBatchCase = contractCase("property-gallery-batch-upload-session");
const propertyTargetDenyCase = contractCase("property-gallery-deny-unresolved-property-target");
const privateChatVisibilityCase = contractCase("private-chat-attachment-rejects-public-visibility");
const propertyHeroPdfCase = contractCase("property-hero-rejects-pdf");

type MediaCreateResponse = {
  contractVersion: string;
  uploadSession: {
    sessionId: string;
    requestedVisibility: string;
    effectiveVisibility: string;
  };
  uploadTargets: Array<{
    uploadTargetId: string;
    method: string;
    clientFileId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  }>;
};

type MediaFinalizeResponse = {
  mediaObject: PlatformMediaObjectRecord;
  mediaObjects: PlatformMediaObjectRecord[];
  sideEffects: string[];
};

type ErrorResponse = {
  code: string;
};

describe("platform media upload routes", () => {
  it("creates a signed property upload session and finalizes it with inspected private variants", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });

    expect(create.statusCode).toBe(propertyGalleryCase.expected.status);
    const createBody = create.body as MediaCreateResponse;
    expect(createBody.contractVersion).toBe("platform-media-upload.v1");
    expect(createBody.uploadSession.requestedVisibility).toBe(
      propertyGalleryCase.expected.requestedVisibility,
    );
    expect(createBody.uploadSession.effectiveVisibility).toBe(
      propertyGalleryCase.expected.effectiveVisibility,
    );
    expect(createBody.uploadTargets).toHaveLength(1);
    expect(createBody.uploadTargets[0]).toMatchObject({
      method: "PUT",
      clientFileId: "hero",
      headers: {
        "content-type": "image/jpeg",
      },
    });
    expect(createBody.uploadTargets[0]!.uploadUrl).toContain("staging%2F");
    expect(repository.auditEvents).toHaveLength(1);
    expect(repository.auditEvents[0]).toMatchObject({
      action: "platform_media.upload_session.created",
      actorUserId: "user_media",
      organizationId: "org_media",
    });

    const finalize = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(finalize.statusCode).toBe(propertyGalleryCase.expected.finalizeStatus);
    const finalizeBody = finalize.body as MediaFinalizeResponse;
    expect(finalizeBody.mediaObjects).toHaveLength(
      propertyGalleryCase.expected.mediaObjectCount ?? 1,
    );
    expect(finalizeBody.mediaObject).toMatchObject(propertyGalleryCase.expected.mediaObject!);
    expect(finalizeBody.mediaObject.variants.map((variant) => variant.variantName)).toEqual([
      ...(propertyGalleryCase.expected.requiredVariants ?? []),
    ]);
    expect(
      finalizeBody.mediaObject.variants.every((variant) => variant.publicCdnUrl === null),
    ).toBe(true);
    expect(finalizeBody.sideEffects).toEqual(propertyGalleryCase.expected.sideEffects);
    expect(repository.auditEvents).toHaveLength(2);
    expect(repository.auditEvents[1]).toMatchObject({
      action: "platform_media.upload_session.finalized",
      organizationId: "org_media",
    });

    const unauthenticatedReplay = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });
    expect(unauthenticatedReplay.statusCode).toBe(401);

    const authenticatedReplay = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });
    expect(authenticatedReplay.statusCode).toBe(200);
    expect((authenticatedReplay.body as { sideEffects: string[] }).sideEffects).toEqual([
      "idempotency_replay",
    ]);
  });

  it("finalizes every signed file in a batch upload session", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryBatchCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryBatchCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    expect(create.statusCode).toBe(201);
    expect(createBody.uploadTargets).toHaveLength(2);

    const finalize = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: [
          {
            uploadTargetId: createBody.uploadTargets[1]!.uploadTargetId,
            ...propertyGalleryBatchCase.finalize!.files[1],
          },
          {
            uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
            ...propertyGalleryBatchCase.finalize!.files[0],
          },
        ],
      },
    });

    expect(finalize.statusCode).toBe(propertyGalleryBatchCase.expected.finalizeStatus);
    const finalizeBody = finalize.body as MediaFinalizeResponse;
    expect(finalizeBody.mediaObjects).toHaveLength(
      propertyGalleryBatchCase.expected.mediaObjectCount ?? 2,
    );
    expect(finalizeBody.mediaObject.mediaId).toBe(finalizeBody.mediaObjects[0]!.mediaId);
    expect(finalizeBody.mediaObjects.map((mediaObject) => mediaObject.originalFilename)).toEqual([
      "alpine suite.jpg",
      "patio.png",
    ]);
    expect(finalizeBody.mediaObjects[0]!.storageKey).toContain("/1/active/alpine suite.jpg");
    expect(finalizeBody.mediaObjects[1]!.storageKey).toContain("/2/active/patio.png");
    expect(finalizeBody.mediaObjects[1]!.variants.map((variant) => variant.storageKey)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/2/variants/original_safe"),
        expect.stringContaining("/2/variants/thumbnail"),
      ]),
    );
    expect((repository.auditEvents[1]!.metadata as { mediaIds: string[] }).mediaIds).toHaveLength(
      2,
    );
  });

  it("rejects property media targets that the resolver cannot prove from the linked resource", async () => {
    const app = buildMediaApp();

    const response = await injectJson(app, {
      method: "POST",
      url: propertyTargetDenyCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyTargetDenyCase.request.body,
    });

    expect(response.statusCode).toBe(propertyTargetDenyCase.expected.status);
    expect((response.body as ErrorResponse).code).toBe(propertyTargetDenyCase.expected.errorCode);
  });

  it("rejects finalize metadata that does not match the inspected staged object", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          contentType: "image/png",
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("media_type_mismatch");
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("rejects unsupported inspected staged content before creating media records", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      finalizer: createDeterministicPlatformMediaFinalizer({
        contentType: "application/pdf",
      }),
    });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("unsupported_media_type");
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("rejects malformed client checksum metadata before inspecting staged content", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          checksumSha256: "abc123",
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("invalid_media_checksum");
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("rejects malformed inspected checksum metadata before creating media records", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      finalizer: createDeterministicPlatformMediaFinalizer({
        checksumSha256: "not-a-sha",
      }),
    });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          checksumSha256: undefined,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("invalid_media_checksum");
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("rejects public visibility for private-only chat attachments", async () => {
    const app = buildMediaApp({
      permissions: ["marketplace.collaboration.review"],
      resources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_lina",
          relationship: "owner",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: privateChatVisibilityCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: privateChatVisibilityCase.request.body,
    });

    expect(response.statusCode).toBe(privateChatVisibilityCase.expected.status);
    expect((response.body as ErrorResponse).code).toBe(
      privateChatVisibilityCase.expected.errorCode,
    );
  });

  it("rejects unsupported content types before signing", async () => {
    const app = buildMediaApp();

    const response = await injectJson(app, {
      method: "POST",
      url: propertyHeroPdfCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyHeroPdfCase.request.body,
    });

    expect(response.statusCode).toBe(propertyHeroPdfCase.expected.status);
    expect((response.body as ErrorResponse).code).toBe(propertyHeroPdfCase.expected.errorCode);
  });

  it("rejects malformed file fields before signing", async () => {
    const app = buildMediaApp();

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        purpose: "property.hero_image",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
        },
        files: [
          {
            filename: "hero.webp",
            contentType: 123,
            sizeBytes: 1024,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("unsupported_media_type");
  });

  const denialCases: Array<{
    name: string;
    auth?: string;
    permissions: PermissionKey[];
    resources: Array<{
      product: Product;
      resourceType: ResourceType;
      resourceId: string;
      relationship: ResourceRelationship;
    }>;
    expectedStatus: number;
  }> = [
    {
      name: "missing authentication",
      auth: undefined,
      permissions: ["booking.settings.manage"],
      resources: [
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
          relationship: "owner",
        },
      ],
      expectedStatus: 401,
    },
    {
      name: "missing permission",
      auth: "Bearer valid-token",
      permissions: [],
      resources: [
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
          relationship: "owner",
        },
      ],
      expectedStatus: 403,
    },
    {
      name: "missing linked resource",
      auth: "Bearer valid-token",
      permissions: ["booking.settings.manage"],
      resources: [],
      expectedStatus: 403,
    },
  ];

  it.each(denialCases)(
    "enforces route policy for $name",
    async ({ auth, permissions, resources, expectedStatus }) => {
      const app = buildMediaApp({ permissions, resources });

      const response = await injectJson(app, {
        method: "POST",
        url: "/api/media/upload-sessions",
        headers: auth ? { authorization: auth } : undefined,
        payload: {
          purpose: "property.hero_image",
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
          },
          files: [
            {
              filename: "hero.webp",
              contentType: "image/webp",
              sizeBytes: 1024,
            },
          ],
        },
      });

      expect(response.statusCode).toBe(expectedStatus);
    },
  );
});

function buildMediaApp(
  options: {
    repository?: PlatformMediaRepository;
    permissions?: PermissionKey[];
    resources?: Array<{
      product: Product;
      resourceType: ResourceType;
      resourceId: string;
      relationship: ResourceRelationship;
    }>;
    targetResolver?: PlatformMediaTargetResolver;
    finalizer?: PlatformMediaUploadFinalizer;
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    platformMedia: {
      repository: options.repository ?? createInMemoryPlatformMediaRepository(),
      signer: createDeterministicPlatformMediaUploadSigner(),
      targetResolver: options.targetResolver ?? propertyMediaTargetResolver,
      finalizer: options.finalizer ?? createDeterministicPlatformMediaFinalizer(),
      now: () => new Date("2026-06-12T12:00:00.000Z"),
    },
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options.resources),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["booking.settings.manage"];
        },
      },
    },
  });
}

const propertyMediaTargetResolver: PlatformMediaTargetResolver = {
  async resolveTarget({ request, policy }) {
    if (
      policy.targetResourceProduct === "hotel_catalog" &&
      request.resource.resourceId === "booking_hotel_alpenrose" &&
      request.resource.propertyId === "property_alpenrose"
    ) {
      return {
        ok: true,
        target: {
          resourceProduct: "hotel_catalog",
          resourceType: "property",
          resourceId: "property_alpenrose",
          propertyId: "property_alpenrose",
        },
      };
    }
    if (policy.targetResourceProduct === "hotel_catalog") {
      return {
        ok: false,
        statusCode: 403,
        code: "media_target_forbidden",
        message: "Property media target is not linked to this booking hotel.",
      };
    }
    return {
      ok: true,
      target: {
        resourceProduct: policy.targetResourceProduct,
        resourceType: policy.targetResourceType,
        resourceId: request.resource.targetResourceId ?? request.resource.resourceId,
        propertyId: request.resource.propertyId,
      },
    };
  },
};

function identityRepository(
  resources: Array<{
    product: Product;
    resourceType: ResourceType;
    resourceId: string;
    relationship: ResourceRelationship;
  }> = [
    {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: "booking_hotel_alpenrose",
      relationship: "owner",
    },
  ],
): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_media",
        email: "media@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "org_media",
        workosOrgId: "workos_media_org",
        kind: "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_media",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "membership_workos_media",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return resources.map((resource) => ({
        ...resource,
        status: "active",
      }));
    },
  };
}

function contractCase(caseId: string): (typeof uploadContractCases.cases)[number] {
  const found = uploadContractCases.cases.find((candidate) => candidate.caseId === caseId);
  if (!found) throw new Error(`Missing platform media upload fixture: ${caseId}`);
  return found;
}
