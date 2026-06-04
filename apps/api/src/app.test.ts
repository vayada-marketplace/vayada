import {
  createFakeVerifier,
  requireAuthContext,
  type ProductEntitlement,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: futureExpiry,
};

const identityRepository: IdentityRepository = {
  async findUserByProviderUserId() {
    return {
      userId: "user_hotel_owner",
      email: "owner@example.com",
      status: "active",
    };
  },
  async findOrganizationByWorkosOrgId() {
    return {
      organizationId: "org_hotel_group",
      workosOrgId: "org_workos_hotel_group",
      kind: "hotel_group",
      status: "active",
    };
  },
  async findActiveMembership() {
    return {
      membershipId: "membership_hotel_owner",
      status: "active",
      roleKey: "hotel_owner",
      workosMembershipId: "om_hotel_owner",
      workosRoleSlugs: ["hotel_owner"],
    };
  },
  async findLinkedResources() {
    return [
      {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: "booking_hotel_alpenrose",
        relationship: "owner",
        status: "active",
      },
    ];
  },
};

function identityRepositoryWithHotel(hotelId = "booking_hotel_alpenrose"): IdentityRepository {
  return {
    ...identityRepository,
    async findLinkedResources() {
      return [
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: hotelId,
          relationship: "owner",
          status: "active",
        },
      ];
    },
  };
}

function buildAuthenticatedApp(
  options: {
    permissions?: PermissionKey[];
    entitlements?: ProductEntitlement[];
    linkedHotelId?: string;
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepositoryWithHotel(options.linkedHotelId),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["booking.settings.manage"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return (
            options.entitlements ?? [
              {
                product: "booking",
                key: "booking-engine",
                status: "active",
              },
            ]
          );
        },
      },
    },
  });
}

describe("vayada-api", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("returns health status without binding a port", async () => {
    app = buildApp({ logger: false });
    const response = await injectJson(app, {
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      service: "vayada-api",
      status: "ok",
    });
  });

  it("registers product route group placeholders", async () => {
    app = buildApp({ logger: false });
    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      group: "booking",
      status: "ok",
    });
  });

  it("wires authorization into authenticated API context resolution", async () => {
    app = buildApp({
      logger: false,
      auth: {
        verifier: createFakeVerifier(new Map([["valid-token", session]])),
        repository: identityRepository,
        rolePermissionRepository: {
          async findPermissionsForRole(kind, roleKey) {
            expect(kind).toBe("hotel_group");
            expect(roleKey).toBe("hotel_owner");
            return ["booking.settings.manage"];
          },
        },
        entitlementRepository: {
          async findEntitlementsForContext(context) {
            expect(context.selectedOrganization.organizationId).toBe("org_hotel_group");
            return [
              {
                product: "booking",
                key: "booking-engine",
                status: "active",
              },
            ];
          },
        },
      },
    });

    app.get("/protected-context", async (request) => {
      const context = requireAuthContext(request);
      return {
        userId: context.actor.internalUserId,
        permissions: context.membership.permissions,
        entitlements: context.entitlements,
      };
    });

    const response = await injectJson<{
      userId: string;
      permissions: string[];
      entitlements: Array<{ product: string; key: string; status: string }>;
    }>(app, {
      method: "GET",
      url: "/protected-context",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      userId: "user_hotel_owner",
      permissions: ["booking.settings.manage"],
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "active",
        },
      ],
    });
  });

  it("allows the booking policy route with auth, permission, entitlement, and linked resource", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson<{
      group: string;
      authorized: boolean;
      hotelId: string;
      userId: string;
    }>(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      group: "booking",
      authorized: true,
      hotelId: "booking_hotel_alpenrose",
      userId: "user_hotel_owner",
    });
  });

  it("rejects the booking policy route without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects the booking policy route with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects the booking policy route when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects the booking policy route when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects the booking policy route when entitlement is suspended", async () => {
    app = buildAuthenticatedApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects the booking policy route when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });
});
