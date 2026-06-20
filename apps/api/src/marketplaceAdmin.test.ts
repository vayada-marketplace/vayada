import {
  createFakeVerifier,
  type IdentityRepository,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type {
  MarketplaceAdminCollaborationsResponse,
  MarketplaceAdminCreateHotelListingRequest,
  MarketplaceAdminDeleteHotelListingResponse,
  MarketplaceAdminHotelListing,
  MarketplaceAdminRepository,
  MarketplaceCollaborationLifecycleWriteResponse,
  MarketplaceCollaborationRead,
} from "./routes/marketplaceAdmin.js";

const platformSession: VerifiedSession = {
  workosUserId: "user_workos_platform",
  workosOrgId: "org_workos_platform",
  sessionId: "session_platform",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const nonPlatformSession: VerifiedSession = {
  workosUserId: "user_workos_creator",
  workosOrgId: "org_workos_creator",
  sessionId: "session_creator",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const collaboration: MarketplaceCollaborationRead = {
  contractVersion: "marketplace-collaboration-reads.v1",
  authorizationMode: "hotel_group_resource_link",
  collaborationId: "collab_801",
  listingId: "listing_801",
  creatorId: "creator_801",
  hotelProfileId: "hotel_profile_801",
  side: "hotel",
  initiatorSide: "creator",
  isInitiator: false,
  status: "pending",
  collaborationType: "free_stay",
  listingName: "Alpine creator stay",
  listingLocation: "Innsbruck, Austria",
  creator: {
    side: "creator",
    organizationId: "org_creator",
    profileId: "creator_profile_801",
    displayName: "Lina Creator",
    avatarUrl: null,
  },
  hotel: {
    side: "hotel",
    organizationId: "org_hotel",
    profileId: "hotel_profile_801",
    displayName: "Hotel Alpenrose",
    avatarUrl: null,
  },
  terms: {
    freeStayMinNights: 2,
    freeStayMaxNights: 4,
    paidAmount: null,
    currency: "EUR",
    discountPercentage: null,
    creatorFee: null,
    travelDateFrom: null,
    travelDateTo: null,
    preferredDateFrom: null,
    preferredDateTo: null,
    preferredMonths: ["June"],
  },
  deliverables: [],
  lastMessageAt: null,
  applicationMessage: "We would be a great fit.",
  hotelAgreedAt: null,
  creatorAgreedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: "2026-06-13T10:00:00.000Z",
  updatedAt: "2026-06-13T10:00:00.000Z",
};

describe("marketplace admin routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("lists collaborations for platform organization members", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson<MarketplaceAdminCollaborationsResponse>(app, {
      method: "GET",
      url: "/api/marketplace/admin/collaborations?page=2&pageSize=5&status=pending&search=Alpine",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.authorizationMode).toBe("platform_organization_membership");
    expect(response.body.collaborations[0]).toMatchObject({
      collaborationId: "collab_801",
      side: "hotel",
    });
    expect(response.body.pagination).toEqual({ page: 2, pageSize: 5, total: 1 });
    expect(repository.calls.listCollaborations[0]).toMatchObject({
      page: 2,
      pageSize: 5,
      status: "pending",
      search: "Alpine",
    });
  });

  it("uses documented legacy superadmin fallback only when explicitly enabled", async () => {
    const repository = createMemoryMarketplaceAdminRepository({
      legacySuperadminUserIds: ["user_creator"],
    });
    app = buildMarketplaceAdminApp(repository, {
      marketplaceAdminLegacySuperadminFallbackEnabled: true,
    });

    const response = await injectJson<MarketplaceAdminCollaborationsResponse>(app, {
      method: "GET",
      url: "/api/marketplace/admin/collaborations",
      headers: { authorization: "Bearer creator-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.authorizationMode).toBe("legacy_superadmin_fallback");
  });

  it("rejects authenticated users without platform membership or superadmin fallback", async () => {
    const repository = createMemoryMarketplaceAdminRepository({
      legacySuperadminUserIds: ["user_creator"],
    });
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/admin/collaborations",
      headers: { authorization: "Bearer creator-token" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("performs admin collaboration actions through typed lifecycle responses", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const respond = await injectJson<MarketplaceCollaborationLifecycleWriteResponse>(app, {
      method: "POST",
      url: "/api/marketplace/admin/collaborations/collab_801/respond",
      headers: {
        authorization: "Bearer platform-token",
        "idempotency-key": "marketplace.admin.collaboration.respond:collab_801:test:v1",
      },
      payload: { status: "accepted", responseMessage: "Approved by admin." },
    });

    expect(respond.statusCode).toBe(200);
    expect(respond.body.command).toMatchObject({
      action: "respond",
      idempotencyKey: "marketplace.admin.collaboration.respond:collab_801:test:v1",
    });
    expect(repository.calls.respond[0]).toMatchObject({
      collaborationId: "collab_801",
      status: "accepted",
      responseMessage: "Approved by admin.",
    });

    const approve = await injectJson<MarketplaceCollaborationLifecycleWriteResponse>(app, {
      method: "POST",
      url: "/api/marketplace/admin/collaborations/collab_801/approve",
      headers: { authorization: "Bearer platform-token" },
      payload: {
        idempotencyKey: "marketplace.admin.collaboration.approve_terms:collab_801:test:v1",
      },
    });

    expect(approve.statusCode).toBe(200);
    expect(approve.body.command.action).toBe("approve_terms");
  });

  it("creates, updates, and archives hotel listings for a hotel user through marketplace admin routes", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);
    const payload = listingPayload();

    const create = await injectJson<MarketplaceAdminHotelListing>(app, {
      method: "POST",
      url: "/api/marketplace/admin/users/user_hotel/listings",
      headers: { authorization: "Bearer platform-token" },
      payload,
    });

    expect(create.statusCode).toBe(201);
    expect(create.body).toMatchObject({
      contractVersion: "marketplace-admin.v1",
      authorizationMode: "platform_organization_membership",
      listingId: "listing_801",
    });
    expect(repository.calls.createListing[0]).toMatchObject({
      hotelUserId: "user_hotel",
      request: { title: "Creator suite" },
    });

    const update = await injectJson<MarketplaceAdminHotelListing>(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_hotel/listings/listing_801",
      headers: { authorization: "Bearer platform-token" },
      payload: { title: "Updated suite" },
    });

    expect(update.statusCode).toBe(200);
    expect(repository.calls.updateListing[0]).toMatchObject({
      hotelUserId: "user_hotel",
      listingId: "listing_801",
      request: { title: "Updated suite" },
    });

    const deleted = await injectJson<MarketplaceAdminDeleteHotelListingResponse>(app, {
      method: "DELETE",
      url: "/api/marketplace/admin/users/user_hotel/listings/listing_801",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.body.deletedListing).toEqual({
      listingId: "listing_801",
      title: "Creator suite",
    });
  });

  it("rejects blank listing titles on marketplace admin updates", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_hotel/listings/listing_801",
      headers: { authorization: "Bearer platform-token" },
      payload: { title: "   " },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ code: "title_required" });
    expect(repository.calls.updateListing).toHaveLength(0);
  });

  it("rejects invalid collaboration offering values on marketplace admin listing updates", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);
    const offering = listingPayload().collaborationOfferings[0]!;

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_hotel/listings/listing_801",
      headers: { authorization: "Bearer platform-token" },
      payload: {
        collaborationOfferings: [
          {
            ...offering,
            freeStayMinNights: 4,
            freeStayMaxNights: 2,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ code: "invalid_free_stay" });
    expect(repository.calls.updateListing).toHaveLength(0);
  });
});

function buildMarketplaceAdminApp(
  repository: MarketplaceAdminRepository,
  options: { marketplaceAdminLegacySuperadminFallbackEnabled?: boolean } = {},
) {
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId(_provider, providerUserId) {
      if (providerUserId === "user_workos_platform") {
        return { userId: "user_platform", email: "admin@vayada.com", status: "active" };
      }
      return { userId: "user_creator", email: "creator@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId(workosOrgId) {
      if (workosOrgId === "org_workos_platform") {
        return {
          organizationId: "org_platform",
          workosOrgId,
          kind: "platform",
          status: "active",
        };
      }
      return {
        organizationId: "org_creator",
        workosOrgId,
        kind: "creator_workspace",
        status: "active",
      };
    },
    async findActiveMembership(_userId, organizationId) {
      if (organizationId === "org_platform") {
        return {
          membershipId: "membership_platform",
          status: "active",
          roleKey: "platform_admin",
          workosMembershipId: null,
          workosRoleSlugs: ["platform_admin"],
        };
      }
      return {
        membershipId: "membership_creator",
        status: "active",
        roleKey: "creator_owner",
        workosMembershipId: null,
        workosRoleSlugs: ["creator_owner"],
      };
    },
    async findLinkedResources(organizationId) {
      if (organizationId === "org_platform") {
        return [
          {
            product: "platform",
            resourceType: "platform",
            resourceId: "vayada",
            relationship: "operator",
            status: "active",
          },
        ];
      }
      return [];
    },
  };

  return buildApp({
    logger: false,
    marketplaceAdminRepository: repository,
    marketplaceAdminLegacySuperadminFallbackEnabled:
      options.marketplaceAdminLegacySuperadminFallbackEnabled,
    auth: {
      verifier: createFakeVerifier(
        new Map([
          ["platform-token", platformSession],
          ["creator-token", nonPlatformSession],
        ]),
      ),
      repository: identityRepository,
      rolePermissionRepository: {
        async findPermissionsForRole(kind) {
          return kind === "platform" ? ["platform.user.suspend"] : ["marketplace.profile.manage"];
        },
      },
    },
  });
}

function createMemoryMarketplaceAdminRepository(
  options: { legacySuperadminUserIds?: string[] } = {},
) {
  const legacySuperadminUserIds = new Set(options.legacySuperadminUserIds ?? []);
  const calls = {
    listCollaborations: [] as unknown[],
    respond: [] as unknown[],
    approve: [] as unknown[],
    createListing: [] as unknown[],
    updateListing: [] as unknown[],
    deleteListing: [] as unknown[],
  };
  const repository: MarketplaceAdminRepository & { calls: typeof calls } = {
    calls,
    async listCollaborations(input) {
      calls.listCollaborations.push(input);
      return { collaborations: [collaboration], total: 1 };
    },
    async respondToCollaborationAsHotel(input) {
      calls.respond.push(input);
      return lifecycleResponse(input.idempotencyKey, "respond");
    },
    async approveCollaborationAsHotel(input) {
      calls.approve.push(input);
      return lifecycleResponse(input.idempotencyKey, "approve_terms");
    },
    async createHotelListingForUser(input) {
      calls.createListing.push(input);
      return listingResponse(input.authorizationMode);
    },
    async updateHotelListingForUser(input) {
      calls.updateListing.push(input);
      return listingResponse(input.authorizationMode, input.request.title ?? "Creator suite");
    },
    async deleteHotelListingForUser(input) {
      calls.deleteListing.push(input);
      return {
        contractVersion: "marketplace-admin.v1",
        authorizationMode: input.authorizationMode,
        deletedListing: { listingId: "listing_801", title: "Creator suite" },
      };
    },
    async isLegacySuperadmin(userId) {
      return legacySuperadminUserIds.has(userId);
    },
  };
  return repository;
}

function lifecycleResponse(
  idempotencyKey: string,
  action: "respond" | "approve_terms",
): MarketplaceCollaborationLifecycleWriteResponse {
  return {
    contractVersion: "marketplace-collaboration-lifecycle-writes.v1",
    command: { action, idempotencyKey },
    collaboration,
    sideEffects: [{ type: "marketplace.collaboration.system_message_requested" }],
  };
}

function listingPayload(): MarketplaceAdminCreateHotelListingRequest {
  return {
    title: "Creator suite",
    listingSummary: "A suite for creator stays.",
    accommodationType: "hotel",
    rawLocationText: "Innsbruck, Austria",
    imageUrls: ["https://cdn.example.com/listing.jpg"],
    collaborationOfferings: [
      {
        collaborationType: "free_stay",
        availabilityMonths: ["June"],
        platforms: ["instagram"],
        freeStayMinNights: 2,
        freeStayMaxNights: 4,
        paidMaxAmount: null,
        discountPercentage: null,
        commissionPercentage: null,
        minFollowers: 10000,
        currency: "EUR",
        termsSummary: null,
      },
    ],
    creatorRequirements: {
      platforms: ["instagram"],
      targetCountries: ["AT"],
      targetAgeMin: 18,
      targetAgeMax: 45,
      targetAgeGroups: ["18-24"],
      creatorTypes: ["travel"],
    },
  };
}

function listingResponse(
  authorizationMode: MarketplaceAdminHotelListing["authorizationMode"],
  title = "Creator suite",
): MarketplaceAdminHotelListing {
  return {
    contractVersion: "marketplace-admin.v1",
    authorizationMode,
    listingId: "listing_801",
    propertyId: "property_801",
    listingStatus: "verified",
    title,
    listingSummary: "A suite for creator stays.",
    accommodationType: "hotel",
    rawLocationText: "Innsbruck, Austria",
    imageUrls: ["https://cdn.example.com/listing.jpg"],
    collaborationOfferings: [
      {
        offeringId: "offering_801",
        collaborationType: "free_stay",
        availabilityMonths: ["June"],
        platforms: ["instagram"],
        freeStayMinNights: 2,
        freeStayMaxNights: 4,
        paidMaxAmount: null,
        discountPercentage: null,
        commissionPercentage: null,
        minFollowers: 10000,
        currency: "EUR",
        termsSummary: null,
      },
    ],
    creatorRequirements: {
      platforms: ["instagram"],
      targetCountries: ["AT"],
      targetAgeMin: 18,
      targetAgeMax: 45,
      targetAgeGroups: ["18-24"],
      creatorTypes: ["travel"],
    },
    createdAt: "2026-06-13T10:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
  };
}
