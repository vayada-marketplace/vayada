import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import {
  createPgMarketplaceAdminRepository,
  mapOfferRow,
  syncPropertyOfferReadModels,
  validateMergedOfferUpdate,
} from "./routes/marketplaceAdmin.js";
import type {
  MarketplaceAdminCreateOfferRequest,
  MarketplaceAdminHotelAccountInviteCreateRequest,
  MarketplaceAdminOffer,
  MarketplaceAdminInviteCode,
  MarketplaceAdminRepository,
  OfferRow,
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

describe("marketplace admin routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("uses documented legacy superadmin fallback only when explicitly enabled", async () => {
    const repository = createMemoryMarketplaceAdminRepository({
      legacySuperadminUserIds: ["user_creator"],
    });
    app = buildMarketplaceAdminApp(repository, {
      marketplaceAdminLegacySuperadminFallbackEnabled: true,
    });

    const response = await injectJson<MarketplaceAdminInviteCode[]>(app, {
      method: "GET",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer creator-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body[0]).toMatchObject({ code: "VAY-INVITE" });
  });

  it("rejects authenticated users without platform membership or superadmin fallback", async () => {
    const repository = createMemoryMarketplaceAdminRepository({
      legacySuperadminUserIds: ["user_creator"],
    });
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer creator-token" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("manages invite codes through marketplace admin target routes", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const list = await injectJson<MarketplaceAdminInviteCode[]>(app, {
      method: "GET",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(list.statusCode).toBe(200);
    expect(list.body[0]).toMatchObject({
      contractVersion: "hotel-account-invite.v1",
      code: "VAY-INVITE",
      handoffPath: "/setup",
    });

    const routeCases: Array<{
      label: string;
      selectedTracks: MarketplaceAdminHotelAccountInviteCreateRequest["selectedTracks"];
    }> = [
      { label: "Marketplace", selectedTracks: ["creator_marketplace"] },
      { label: "Hotel Operations", selectedTracks: ["hotel_operations"] },
      {
        label: "combined",
        selectedTracks: ["hotel_operations", "creator_marketplace"],
      },
    ];

    for (const routeCase of routeCases) {
      const payload = hotelInviteRequest(routeCase.selectedTracks);
      const created = await injectJson<MarketplaceAdminInviteCode>(app, {
        method: "POST",
        url: "/api/marketplace/admin/invite-codes",
        headers: { authorization: "Bearer platform-token" },
        payload,
      });

      expect(created.statusCode, routeCase.label).toBe(201);
      expect(created.body, routeCase.label).toMatchObject({
        contractVersion: "hotel-account-invite.v1",
        identity: { email: "owner@example.test" },
        organization: { displayName: "Alpenrose Hospitality" },
        property: { displayName: "Hotel Alpenrose" },
        selectedTracks: routeCase.selectedTracks,
        handoffPath: "/setup",
      });
    }

    expect(repository.calls.createInviteCode).toHaveLength(3);
    expect(repository.calls.createInviteCode[2]).toMatchObject({
      createdByUserId: "user_platform",
      invite: {
        contractVersion: "hotel-account-invite.v1",
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        handoffPath: "/setup",
      },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/admin/invite-codes/invite_801",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(deleted.statusCode).toBe(204);
    expect(repository.calls.revokeInviteCode).toEqual(["invite_801"]);
  });

  it("rejects retired setup payloads and invalid setup tracks", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const retiredPayload = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer platform-token" },
      payload: {
        ...hotelInviteRequest(["hotel_operations"]),
        policies: { payout_iban: "must-not-be-stored" },
      },
    });
    expect(retiredPayload.statusCode).toBe(422);
    expect(retiredPayload.body).toMatchObject({ code: "unsupported_invite_field" });

    const invalidTrack = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer platform-token" },
      payload: {
        ...hotelInviteRequest(["hotel_operations"]),
        selectedTracks: ["booking"],
      },
    });
    expect(invalidTrack.statusCode).toBe(422);
    expect(invalidTrack.body).toMatchObject({ code: "invalid_selected_tracks" });
    expect(repository.calls.createInviteCode).toHaveLength(0);
  });

  it("requires platform authorization before creating a hotel invite", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);
    const payload = hotelInviteRequest(["creator_marketplace"]);

    const unauthenticated = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/admin/invite-codes",
      payload,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const unauthorized = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer creator-token" },
      payload,
    });
    expect(unauthorized.statusCode).toBe(403);
    expect(repository.calls.createInviteCode).toHaveLength(0);
  });

  it("scopes invite list and revoke queries to the hotel account contract", async () => {
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      pool: createAdminPgPool(sql, { revokeInviteExists: true }) as never,
    });

    await expect(repository.listInviteCodes()).resolves.toEqual([]);
    await expect(repository.revokeInviteCode("invite_legacy_or_non_hotel")).resolves.toBe(true);

    expect(sql[0]).toContain("invite.invite_type = 'hotel'");
    expect(sql[0]).toContain("invite.payload ->> 'contractVersion' = $1");
    const lockedInvite = sql.find((statement) => statement.includes("FOR UPDATE"));
    const redemptionGuard = sql.find((statement) =>
      statement.includes("FROM platform.idempotency_keys redemption"),
    );
    expect(lockedInvite).toContain("invite_type = 'hotel'");
    expect(lockedInvite).toContain("payload ->> 'contractVersion' = $2");
    expect(redemptionGuard).toContain("redemption.operation = 'hotel_setup.tracks.update'");
    expect(redemptionGuard).toContain("JOIN identity.organizations organization");
    expect(redemptionGuard).toContain("redemption.correlation_id = $1");
    expect(redemptionGuard).toContain("organization.workos_external_id = $2");
    expect(redemptionGuard).toContain("redemption.response_status_code = 200");
    expect(sql).toContain("COMMIT");
  });

  it("refuses revocation after canonical invite intent commits but before finalization recovers", async () => {
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      pool: createAdminPgPool(sql, {
        revokeInviteExists: true,
        successfulInviteRedemption: true,
      }) as never,
    });

    await expect(repository.revokeInviteCode("invite_pending_recovery")).resolves.toBe(false);

    expect(sql.some((statement) => statement.includes("FOR UPDATE"))).toBe(true);
    expect(sql.some((statement) => statement.includes("SET status = 'revoked'"))).toBe(false);
    expect(sql).toContain("ROLLBACK");
  });

  it("refreshes every nonarchived offer projection for a canonical profile write", async () => {
    const propertyId = "f8013000-0000-0000-0000-000000000001";
    const offerIds = [
      "f8015000-0000-0000-0000-000000000001",
      "f8015000-0000-0000-0000-000000000002",
    ];
    const projectedOfferIds: string[] = [];
    const statements: string[] = [];
    const client = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: T[] }> {
        statements.push(text);
        let rows: unknown[] = [];
        if (text.includes('offer.id::text AS "offerId"')) {
          rows = offerIds.map((offerId) => ({ offerId }));
        } else if (text.includes('offer.property_id::text AS "propertyId"')) {
          rows = [{ propertyId }];
        } else if (text.includes('property.display_name AS "displayName"')) {
          rows = [
            {
              propertyId,
              publicId: "prop_alpenrose",
              displayName: "Hotel Alpenrose",
              defaultLocale: "en",
              canonicalSlug: "hotel-alpenrose",
            },
          ];
        } else if (text.includes("INSERT INTO marketplace.marketplace_offer_read_model")) {
          projectedOfferIds.push(String(values?.[0]));
        }
        return { rows: rows as T[] };
      },
    };

    await syncPropertyOfferReadModels(client, {
      propertyId,
    });

    expect(projectedOfferIds).toEqual(offerIds);
    expect(
      statements.find((statement) => statement.includes('offer.id::text AS "offerId"')),
    ).toContain("offer.offer_status <> 'archived'");
    expect(
      statements.find((statement) => statement.includes('offer.id::text AS "offerId"')),
    ).not.toContain("offer.organization_id");
  });

  it("retains pending offer media metadata for the owner without publishing a URL", () => {
    const offer = mapOfferRow(
      {
        ...adminOfferRow("offer_801", "property_801"),
        offerStatus: "pending",
        media: [
          {
            mediaObjectId: "media_801",
            url: null,
            approvalStatus: "pending_domain_approval",
            lifecycleStatus: "staged",
          },
        ],
      },
      "platform_organization_membership",
    );

    expect(offer.media).toEqual([
      {
        mediaObjectId: "media_801",
        url: null,
        approvalStatus: "pending_domain_approval",
        lifecycleStatus: "staged",
      },
    ]);
    expect(offer.matchingCriteria).toBeNull();
  });

  it("maps explicit matching criteria and requirement levels on offer reads", () => {
    const offer = mapOfferRow(
      {
        ...adminOfferRow("offer_801", "property_801"),
        deliverables: [
          {
            deliverableId: "deliverable_801",
            platform: "instagram",
            deliverableType: "reel",
            quantity: 1,
            timingGuidance: null,
            requirementLevel: "required",
          },
        ],
        matchingCriteria: matchingCriteriaDocument(),
      },
      "platform_organization_membership",
    );

    expect(offer.deliverables[0]?.requirementLevel).toBe("required");
    expect(offer.matchingCriteria).toMatchObject({
      contractVersion: "marketplace-offer-matching-criteria.v1",
      revision: 1,
      primaryCampaignGoal: "ugc_asset_creation",
    });
  });

  it("validates one-sided updates against the persisted matching inputs", () => {
    const current = { ...offerResponse("platform_organization_membership") };
    current.matchingCriteria = matchingCriteriaDocument();

    expect(
      validateMergedOfferUpdate(current, {
        creatorRequirements: {
          ...current.creatorRequirements!,
          platforms: ["tiktok"],
          platformRequirementLevel: "required",
        },
      }),
    ).toBe("inconsistent_requirement_platforms");
    expect(
      validateMergedOfferUpdate(current, {
        matchingCriteria: {
          ...matchingCriteriaWrite(),
          expectedCompensationValue: { amount: "900.00", currency: "USD" },
        },
      }),
    ).toBe("inconsistent_compensation_currency");
  });
});

function createAdminPgPool(
  sql: string[],
  options: { revokeInviteExists?: boolean; successfulInviteRedemption?: boolean } = {},
) {
  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
  ): Promise<{ rows: T[] }> => {
    sql.push(text);
    let rows: unknown[] = [];
    if (text.includes("SELECT EXISTS (") && text.includes("FROM platform.idempotency_keys")) {
      rows = [{ exists: options.successfulInviteRedemption ?? false }];
    } else if (text.includes("FROM platform.idempotency_keys")) {
      rows = [];
    } else if (text.includes("INSERT INTO platform.idempotency_keys")) {
      rows = [{ id: "idempotency_801" }];
    } else if (
      options.revokeInviteExists &&
      text.includes("FROM marketplace.invite_codes") &&
      text.includes("FOR UPDATE")
    ) {
      rows = [{ id: "invite_legacy_or_non_hotel" }];
    } else if (text.includes("SET status = 'revoked'")) {
      rows = [{ id: "invite_legacy_or_non_hotel" }];
    }
    return { rows: rows as T[] };
  };

  const client = { query, release() {} };
  return {
    query,
    async connect() {
      return client;
    },
    async end() {},
  };
}

function adminOfferRow(offerId: string, propertyId: string): OfferRow {
  return {
    offerId,
    propertyId,
    offerStatus: "verified",
    title: "Creator suite",
    offerSummary: "A suite for creator stays.",
    media: [],
    deliverables: [],
    compensationOptions: [],
    creatorRequirements: {},
    createdAt: "2026-06-13T10:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
  };
}

function buildMarketplaceAdminApp(
  repository: MarketplaceAdminRepository,
  options: {
    marketplaceAdminLegacySuperadminFallbackEnabled?: boolean;
    permissions?: readonly PermissionKey[];
    entitlements?: readonly ProductEntitlement[];
    platformLink?: boolean;
  } = {},
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
      if (organizationId === "org_platform" && options.platformLink !== false) {
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
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole(kind) {
          return kind === "platform"
            ? [...(options.permissions ?? ["platform.user.suspend"])]
            : ["marketplace.profile.manage"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return [...(options.entitlements ?? [platformAdminEntitlement()])];
        },
      },
    },
  });
}

function createMemoryMarketplaceAdminRepository(
  options: {
    legacySuperadminUserIds?: string[];
  } = {},
) {
  const legacySuperadminUserIds = new Set(options.legacySuperadminUserIds ?? []);
  const calls = {
    createInviteCode: [] as unknown[],
    revokeInviteCode: [] as unknown[],
  };
  const repository: MarketplaceAdminRepository & { calls: typeof calls } = {
    calls,
    async listInviteCodes() {
      return [inviteCodeResponse()];
    },
    async createInviteCode(input) {
      calls.createInviteCode.push(input);
      return inviteCodeResponse("invite_created", "VAY-CREATED", input.invite);
    },
    async revokeInviteCode(inviteCodeId) {
      calls.revokeInviteCode.push(inviteCodeId);
      return inviteCodeId === "invite_801";
    },
    async isLegacySuperadmin(userId) {
      return legacySuperadminUserIds.has(userId);
    },
  };
  return repository;
}

function platformAdminEntitlement(
  status: ProductEntitlement["status"] = "active",
): ProductEntitlement {
  return {
    product: "platform",
    key: "platform-admin",
    status,
    resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
  };
}

function inviteCodeResponse(
  id = "invite_801",
  code = "VAY-INVITE",
  invite: MarketplaceAdminHotelAccountInviteCreateRequest = hotelInviteRequest([
    "creator_marketplace",
  ]),
): MarketplaceAdminInviteCode {
  return {
    contractVersion: "hotel-account-invite.v1",
    id,
    code,
    status: "pending",
    createdAt: "2026-06-13T10:00:00.000Z",
    expiresAt: "2026-07-13T10:00:00.000Z",
    identity: invite.identity,
    organization: invite.organization,
    property: invite.property,
    selectedTracks: invite.selectedTracks,
    handoffPath: "/setup",
    redeemedAt: null,
  };
}

function hotelInviteRequest(
  selectedTracks: MarketplaceAdminHotelAccountInviteCreateRequest["selectedTracks"],
): MarketplaceAdminHotelAccountInviteCreateRequest {
  return {
    identity: { email: "owner@example.test" },
    organization: { displayName: "Alpenrose Hospitality" },
    property: { displayName: "Hotel Alpenrose" },
    selectedTracks,
  };
}

function matchingCriteriaDocument(): NonNullable<MarketplaceAdminOffer["matchingCriteria"]> {
  return {
    primaryCampaignGoal: "ugc_asset_creation",
    availability: {
      requirementLevel: "required",
      flexibility: "flexible",
      startsOn: "2026-10-01",
      endsOn: "2026-10-31",
      blackouts: [],
    },
    contentCategories: { requirementLevel: "required", values: ["travel"] },
    contentStyles: { requirementLevel: "preferred", values: ["cinematic"] },
    usageRights: {
      channels: ["organic_social"],
      duration: { mode: "fixed", days: 365 },
    },
    includedRevisionRounds: 2,
    expectedEffortHours: { minimum: 6, maximum: 10 },
    expectedCompensationValue: { amount: "900.00", currency: "EUR" },
    applicationCapacity: { acceptingApplications: true, maximumActiveApplications: 20 },
    contractVersion: "marketplace-offer-matching-criteria.v1",
    revision: 1,
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function matchingCriteriaWrite(): NonNullable<
  MarketplaceAdminCreateOfferRequest["matchingCriteria"]
> {
  const document = matchingCriteriaDocument();
  return {
    primaryCampaignGoal: document.primaryCampaignGoal,
    availability: document.availability,
    contentCategories: document.contentCategories,
    contentStyles: document.contentStyles,
    usageRights: document.usageRights,
    includedRevisionRounds: document.includedRevisionRounds,
    expectedEffortHours: document.expectedEffortHours,
    expectedCompensationValue: document.expectedCompensationValue,
    applicationCapacity: document.applicationCapacity,
  };
}

function offerResponse(
  authorizationMode: MarketplaceAdminOffer["authorizationMode"],
  title = "Creator suite",
): MarketplaceAdminOffer {
  return {
    contractVersion: "marketplace-admin.v1",
    authorizationMode,
    offerId: "offer_801",
    propertyId: "property_801",
    offerStatus: "verified",
    title,
    offerSummary: "A suite for creator stays.",
    media: [],
    deliverables: [
      {
        deliverableId: "deliverable_801",
        platform: "instagram",
        deliverableType: "reel",
        quantity: 1,
        timingGuidance: "During the stay",
      },
    ],
    compensationOptions: [
      {
        compensationOptionId: "compensation_801",
        compensationType: "free_stay",
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
    matchingCriteria: null,
    createdAt: "2026-06-13T10:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
  };
}
