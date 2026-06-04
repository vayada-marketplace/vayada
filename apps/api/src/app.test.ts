import {
  createFakeVerifier,
  requireAuthContext,
  type IdentityRepository,
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
      },
    });

    app.get("/protected-context", async (request) => {
      const context = requireAuthContext(request);
      return {
        userId: context.actor.internalUserId,
        permissions: context.membership.permissions,
      };
    });

    const response = await injectJson<{
      userId: string;
      permissions: string[];
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
    });
  });
});
