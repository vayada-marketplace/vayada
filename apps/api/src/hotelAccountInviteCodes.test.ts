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
  createPgHotelAccountInviteCodeRepository,
  storedHotelAccountInviteTracks,
} from "./routes/hotelAccountInviteCodes.js";
import type {
  HotelAccountInviteCreateRequest,
  HotelAccountInviteCode,
  HotelAccountInviteCodeRepository,
} from "./routes/hotelAccountInviteCodes.js";

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

describe("hotel account invite code routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("rejects authenticated users without platform membership", async () => {
    const repository = createMemoryHotelAccountInviteCodeRepository();
    app = buildInviteCodeApp(repository);

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer creator-token" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("manages invite codes through the platform admin routes", async () => {
    const repository = createMemoryHotelAccountInviteCodeRepository();
    app = buildInviteCodeApp(repository);

    const list = await injectJson<HotelAccountInviteCode[]>(app, {
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
      selectedTracks: HotelAccountInviteCreateRequest["selectedTracks"];
    }> = [{ label: "Hotel Operations", selectedTracks: ["hotel_operations"] }];

    for (const routeCase of routeCases) {
      const payload = hotelInviteRequest(routeCase.selectedTracks);
      const created = await injectJson<HotelAccountInviteCode>(app, {
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

    expect(repository.calls.createInviteCode).toHaveLength(1);
    expect(repository.calls.createInviteCode[0]).toMatchObject({
      createdByUserId: "user_platform",
      invite: {
        contractVersion: "hotel-account-invite.v1",
        selectedTracks: ["hotel_operations"],
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
    const repository = createMemoryHotelAccountInviteCodeRepository();
    app = buildInviteCodeApp(repository);

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

    // The Creator Marketplace track is retired (VAY-2270): new invites cannot name it.
    for (const selectedTracks of [
      ["creator_marketplace"],
      ["hotel_operations", "creator_marketplace"],
    ]) {
      const retiredTrack = await injectJson(app, {
        method: "POST",
        url: "/api/marketplace/admin/invite-codes",
        headers: { authorization: "Bearer platform-token" },
        payload: { ...hotelInviteRequest(["hotel_operations"]), selectedTracks },
      });
      expect(retiredTrack.statusCode, selectedTracks.join("+")).toBe(422);
      expect(retiredTrack.body).toMatchObject({ code: "invalid_selected_tracks" });
    }
    expect(repository.calls.createInviteCode).toHaveLength(0);
  });

  it("reads stored invites that still name the retired Creator Marketplace track as Hotel Operations", () => {
    expect(storedHotelAccountInviteTracks(["creator_marketplace"])).toEqual(["hotel_operations"]);
    expect(storedHotelAccountInviteTracks(["hotel_operations", "creator_marketplace"])).toEqual([
      "hotel_operations",
    ]);
    expect(storedHotelAccountInviteTracks(["hotel_operations"])).toEqual(["hotel_operations"]);
    // Anything that is not an array is left for the parser to reject.
    expect(storedHotelAccountInviteTracks("hotel_operations")).toBe("hotel_operations");
  });

  it("requires platform authorization before creating a hotel invite", async () => {
    const repository = createMemoryHotelAccountInviteCodeRepository();
    app = buildInviteCodeApp(repository);
    const payload = hotelInviteRequest(["hotel_operations"]);

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
    const repository = createPgHotelAccountInviteCodeRepository({
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
    const repository = createPgHotelAccountInviteCodeRepository({
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

function buildInviteCodeApp(
  repository: HotelAccountInviteCodeRepository,
  options: {
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
    hotelAccountInviteCodeRepository: repository,
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

function createMemoryHotelAccountInviteCodeRepository() {
  const calls = {
    createInviteCode: [] as unknown[],
    revokeInviteCode: [] as unknown[],
  };
  const repository: HotelAccountInviteCodeRepository & { calls: typeof calls } = {
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
  invite: HotelAccountInviteCreateRequest = hotelInviteRequest(["hotel_operations"]),
): HotelAccountInviteCode {
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
  selectedTracks: HotelAccountInviteCreateRequest["selectedTracks"],
): HotelAccountInviteCreateRequest {
  return {
    identity: { email: "owner@example.test" },
    organization: { displayName: "Alpenrose Hospitality" },
    property: { displayName: "Hotel Alpenrose" },
    selectedTracks,
  };
}
