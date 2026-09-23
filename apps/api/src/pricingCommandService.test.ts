import { AuthError, type IdentityRepository, type PermissionKey } from "@vayada/backend-auth";
import { afterEach, describe, expect, it, vi, type MockedFunction } from "vitest";

import { PricingStorageError } from "./domains/replacementPricingStore.js";
import {
  buildPricingCommandService,
  type PricingAuthorityOperations,
} from "./pricingCommandService.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const otherPropertyId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const membershipId = "55555555-5555-4555-8555-555555555555";
const internalToken = "internal-token-with-at-least-32-bytes";
const apps: ReturnType<typeof buildPricingCommandService>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function identityRepository(status: "active" | "inactive" = "active"): IdentityRepository {
  return {
    findUserByProviderUserId: vi.fn().mockResolvedValue({
      userId,
      email: "owner@example.test",
      status: "active",
    }),
    findOrganizationByWorkosOrgId: vi.fn().mockResolvedValue({
      organizationId,
      workosOrgId: "org_workos",
      kind: "hotel_group",
      status: "active",
    }),
    findActiveMembership: vi.fn().mockResolvedValue({
      membershipId,
      status,
      roleKey: "owner",
      workosMembershipId: null,
      workosRoleSlugs: ["owner"],
    }),
    findLinkedResources: vi.fn().mockResolvedValue([
      {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        relationship: "owner",
        status: "active",
      },
    ]),
  };
}

function fixture(
  options: {
    permissions?: PermissionKey[];
    sessionId?: string | null;
    membershipStatus?: "active" | "inactive";
    ownerManage?: PricingAuthorityOperations["save"];
  } = {},
) {
  const ownerRead = vi.fn().mockResolvedValue({ authority: "unconfigured", revision: null });
  const ownerManage = (options.ownerManage ??
    vi.fn().mockResolvedValue({
      revision: otherPropertyId,
      replayed: false,
    })) as MockedFunction<PricingAuthorityOperations["save"]>;
  const permissions = options.permissions ?? ["pms.rooms_rates.read", "pms.rooms_rates.manage"];
  const app = buildPricingCommandService({
    logger: false,
    internalToken,
    propertyId,
    auth: {
      async verifier(token) {
        if (token !== "valid") throw new AuthError("TOKEN_INVALID", "invalid");
        return {
          workosUserId: "user_workos",
          workosOrgId: "org_workos",
          sessionId: options.sessionId === undefined ? "session_workos" : options.sessionId,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        };
      },
      repository: identityRepository(options.membershipStatus),
      rolePermissionRepository: {
        findPermissionsForRole: vi.fn().mockResolvedValue(permissions),
      },
      entitlementRepository: {
        findEntitlementsForContext: vi.fn().mockResolvedValue([
          {
            product: "pms",
            key: "property-management",
            status: "active",
            resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
          },
        ]),
      },
      propertyAccessRepository: {
        findMembershipPropertyScope: vi.fn().mockResolvedValue({
          mode: "all",
          roleKey: "owner",
          accessOrigin: "agency",
          assignedPropertyIds: [],
          productAccess: { pms: true, booking: true },
        }),
      },
    },
    ownerRead,
    ownerManage,
  });
  apps.push(app);
  const headers = {
    authorization: "Bearer valid",
    "x-vayada-internal-token": internalToken,
  };
  return { app, headers, ownerRead, ownerManage };
}

describe("private pricing command service owner boundary", () => {
  it("independently resolves the original bearer and selects read versus manage operations", async () => {
    const f = fixture();
    const read = await f.app.inject({
      method: "GET",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: f.headers,
    });
    expect(read.statusCode).toBe(200);
    expect(f.ownerRead).toHaveBeenCalledOnce();
    expect(f.ownerRead.mock.calls[0]?.[1]).toEqual({
      propertyId,
      organizationId,
      actorUserId: userId,
    });
    expect(f.ownerManage).not.toHaveBeenCalled();

    const write = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...f.headers, "idempotency-key": "choose-vayada" },
      payload: { expectedRevision: null, authority: "vayada" },
    });
    expect(write.statusCode).toBe(200);
    expect(f.ownerManage).toHaveBeenCalledOnce();
    expect(f.ownerManage.mock.calls[0]?.[2]).toEqual({
      requestId: "choose-vayada",
      expectedRevision: null,
      authority: "vayada",
    });
  });

  it("fails closed before selecting a pool for caller, bearer, property or session gaps", async () => {
    for (const request of [
      { headers: { authorization: "Bearer valid" }, property: propertyId },
      {
        headers: { "x-vayada-internal-token": internalToken, authorization: "Bearer invalid" },
        property: propertyId,
      },
      { headers: fixture().headers, property: otherPropertyId },
    ]) {
      const f = fixture();
      const response = await f.app.inject({
        method: "GET",
        url: `/v1/owner/properties/${request.property}/authority`,
        headers: request.headers,
      });
      expect([401, 403]).toContain(response.statusCode);
      expect(f.ownerRead).not.toHaveBeenCalled();
    }
    const noSession = fixture({ sessionId: null });
    expect(
      (
        await noSession.app.inject({
          method: "GET",
          url: `/v1/owner/properties/${propertyId}/authority`,
          headers: noSession.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(noSession.ownerRead).not.toHaveBeenCalled();
  });

  it("rejects forwarded identity context and read-only staff cannot manage", async () => {
    const forged = fixture();
    const forgedResponse = await forged.app.inject({
      method: "GET",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...forged.headers, "x-vayada-role": "owner" },
    });
    expect(forgedResponse.statusCode).toBe(400);
    expect(forged.ownerRead).not.toHaveBeenCalled();

    const readOnly = fixture({ permissions: ["pms.rooms_rates.read"] });
    const manageResponse = await readOnly.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...readOnly.headers, "idempotency-key": "manage" },
      payload: { expectedRevision: null, authority: "vayada" },
    });
    expect(manageResponse.statusCode).toBe(403);
    expect(readOnly.ownerManage).not.toHaveBeenCalled();
  });

  it("runs independent admission before parsing a malformed command and rejects query selectors", async () => {
    const f = fixture();
    const malformed = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: {
        "x-vayada-internal-token": internalToken,
        authorization: "Bearer invalid",
        "content-type": "application/json",
      },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(401);
    expect(f.ownerManage).not.toHaveBeenCalled();

    const query = await f.app.inject({
      method: "GET",
      url: `/v1/owner/properties/${propertyId}/authority?organizationId=${organizationId}`,
      headers: f.headers,
    });
    expect(query.statusCode).toBe(403);
    expect(f.ownerRead).not.toHaveBeenCalled();
  });

  it("rejects unknown body keys and preserves revocation denial from the transactional store", async () => {
    const f = fixture({
      ownerManage: vi.fn().mockRejectedValue(new PricingStorageError("denied")),
    });
    const unknown = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...f.headers, "idempotency-key": "unknown" },
      payload: { expectedRevision: null, authority: "vayada", organizationId },
    });
    expect(unknown.statusCode).toBe(400);
    expect(f.ownerManage).not.toHaveBeenCalled();

    const revoked = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...f.headers, "idempotency-key": "revoked" },
      payload: { expectedRevision: null, authority: "vayada" },
    });
    expect(revoked.statusCode).toBe(403);
  });

  it("preserves the existing idempotency-key contract", async () => {
    const f = fixture();
    const accepted = await f.app.inject({
      method: "PUT",
      url: `/v1/owner/properties/${propertyId}/authority`,
      headers: { ...f.headers, "idempotency-key": "owner choice 1" },
      payload: { expectedRevision: null, authority: "vayada" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(f.ownerManage.mock.calls[0]?.[2]).toMatchObject({ requestId: "owner choice 1" });

    for (const key of [" leading", "trailing ", "a,b", ""]) {
      const rejected = await f.app.inject({
        method: "PUT",
        url: `/v1/owner/properties/${propertyId}/authority`,
        headers: { ...f.headers, "idempotency-key": key },
        payload: { expectedRevision: null, authority: "vayada" },
      });
      expect(rejected.statusCode).toBe(400);
    }
  });
});
