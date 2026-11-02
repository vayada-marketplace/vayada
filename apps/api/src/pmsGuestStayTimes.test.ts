import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ResourceRelationship,
} from "@vayada/backend-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type { PmsGuestStayTimesRepository } from "./routes/pmsGuestStayTimes.js";

const propertyId = "24550000-0000-4000-8000-000000000001";
const organizationId = "11111111-1111-1111-1111-111111111111";
const url = `/api/pms/properties/${propertyId}/guest-stay-times`;
const headers = { authorization: "Bearer valid-token" };
// The old Front desk preset's PMS permissions (0109): no booking.* permission.
const FRONT_DESK: PermissionKey[] = [
  "pms.dashboard.read",
  "pms.calendar.read",
  "pms.reservation.read",
  "pms.reservation.update",
];

function buildAuthenticatedApp(options: {
  repository: PmsGuestStayTimesRepository;
  permissions?: PermissionKey[];
  relationship?: ResourceRelationship;
  /** The property the member's account is linked to, and the one its PMS entitlement is for. */
  linkedPropertyId?: string;
  entitledPropertyId?: string;
}) {
  const relationship = options.relationship ?? "front_desk";
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId() {
      return {
        userId: "22222222-2222-2222-2222-222222222222",
        email: "desk@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return { organizationId, workosOrgId: "workos-org-1", kind: "hotel_group", status: "active" };
    },
    async findActiveMembership() {
      return {
        membershipId: "33333333-3333-3333-3333-333333333333",
        status: "active",
        roleKey: relationship === "front_desk" ? "front_desk" : "hotel_owner",
        workosMembershipId: "workos-membership-1",
        workosRoleSlugs: [relationship === "front_desk" ? "front_desk" : "hotel_owner"],
      };
    },
    async findLinkedResources() {
      const linked = options.linkedPropertyId ?? propertyId;
      return [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: linked,
          relationship,
          status: "active",
        },
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: linked,
          relationship,
          status: "active",
        },
      ];
    },
  };
  return buildApp({
    logger: false,
    pmsOperationsAllowedOrigins: ["https://pms.test"],
    pmsGuestStayTimesRepository: options.repository,
    auth: {
      verifier: createFakeVerifier(
        new Map([
          [
            "valid-token",
            {
              workosUserId: "workos-user-1",
              workosOrgId: "workos-org-1",
              sessionId: "session-1",
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        ]),
      ),
      repository: identityRepository,
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? FRONT_DESK;
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return [
            {
              product: "pms",
              key: "property-management",
              status: "active",
              resource: {
                product: "pms",
                resourceType: "pms_property",
                resourceId: options.entitledPropertyId ?? propertyId,
              },
            },
          ];
        },
      },
    },
  });
}

describe("PMS guest stay times (VAY-2455)", () => {
  let app: ReturnType<typeof buildApp> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("gives the front desk the guest rules' check-in and check-out times, read only", async () => {
    const find = vi.fn(async () => ({ checkInTime: "14:00", checkOutTime: "10:30" }));
    app = buildAuthenticatedApp({ repository: { find } });
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      propertyId,
      times: { checkInTime: "14:00", checkOutTime: "10:30" },
    });
    expect(find).toHaveBeenCalledWith(propertyId, organizationId);
    for (const method of ["PUT", "POST", "DELETE"] as const)
      expect((await app.inject({ method, url, headers, payload: {} })).statusCode).toBe(404);
  });

  it("answers no times while the property has no guest rules", async () => {
    app = buildAuthenticatedApp({
      repository: { find: async () => null },
      relationship: "owner",
      permissions: ["pms.reservation.read"],
    });
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ propertyId, times: null });
  });

  it("refuses members who can't read bookings, anyone signed out and a malformed property", async () => {
    const find = vi.fn(async () => null);
    // Housekeeping: the dashboard and room status, no bookings.
    app = buildAuthenticatedApp({
      repository: { find },
      permissions: ["pms.dashboard.read", "pms.calendar.read", "pms.room_status.read"],
    });
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const malformed = await app.inject({
      method: "GET",
      url: "/api/pms/properties/not-a-property/guest-stay-times",
      headers,
    });
    expect(malformed.statusCode).toBe(400);
    expect(find).not.toHaveBeenCalled();
  });

  it("never reads another property's times, one without the PMS, or for a foreign site", async () => {
    const otherProperty = "24550000-0000-4000-8000-000000000002";
    for (const access of [
      { linkedPropertyId: otherProperty },
      { entitledPropertyId: otherProperty },
    ]) {
      const find = vi.fn(async () => null);
      app = buildAuthenticatedApp({ repository: { find }, ...access });
      expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
      expect(find).not.toHaveBeenCalled();
      await app.close();
    }
    const find = vi.fn(async () => null);
    app = buildAuthenticatedApp({ repository: { find } });
    const foreign = await app.inject({
      method: "GET",
      url,
      headers: { ...headers, origin: "https://evil.test" },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual({ code: "origin_not_allowed" });
    const pms = await app.inject({
      method: "GET",
      url,
      headers: { ...headers, origin: "https://pms.test" },
    });
    expect(pms.statusCode).toBe(200);
    expect(pms.headers["access-control-allow-origin"]).toBe("https://pms.test");
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("says the times are unavailable when they can't be read", async () => {
    app = buildAuthenticatedApp({
      repository: {
        find: async () => {
          throw new Error("Stored guest rules are invalid.");
        },
      },
    });
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "guest_stay_times_unavailable" });
  });
});
