import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ResourceRelationship,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type {
  BookingModule,
  BookingModuleRepository,
  BookingModuleSwitches,
  BookingModulesResponse,
} from "./routes/pmsBookingModules.js";

const propertyId = "22000000-0000-4000-8000-000000000001";
const organizationId = "11111111-1111-1111-1111-111111111111";
const actorUserId = "22222222-2222-2222-2222-222222222222";
const url = `/api/pms/properties/${propertyId}/booking-modules`;
const headers = { authorization: "Bearer valid-token" };
const now = "2026-10-15T08:00:00.000Z";

function createRepository(
  initial: BookingModuleSwitches | null = {
    "add-ons": true,
    promos: true,
    updatedAt: now,
  },
) {
  let switches = initial;
  const updates: Array<{ propertyId: string; moduleId: string; isActive: boolean }> = [];
  const repository: BookingModuleRepository & { updates: typeof updates; fail?: boolean } = {
    updates,
    async read() {
      if (repository.fail) throw new Error("database unavailable");
      return switches;
    },
    async update({ propertyId: id, moduleId, isActive, audit }) {
      if (repository.fail) throw new Error("database unavailable");
      expect(audit).toMatchObject({ actorUserId, organizationId });
      if (!switches) return null;
      updates.push({ propertyId: id, moduleId, isActive });
      switches = { ...switches, [moduleId]: isActive };
      return { moduleId, isActive, activatedAt: null, deactivatedAt: null, updatedAt: now };
    },
  };
  return repository;
}

function buildAuthenticatedApp(
  options: {
    repository?: BookingModuleRepository;
    permissions?: PermissionKey[];
    relationship?: ResourceRelationship;
    allowedOrigins?: string[];
  } = {},
) {
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId() {
      return { userId: actorUserId, email: "owner@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return { organizationId, workosOrgId: "workos-org-1", kind: "hotel_group", status: "active" };
    },
    async findActiveMembership() {
      return {
        membershipId: "33333333-3333-3333-3333-333333333333",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "workos-membership-1",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      const relationship = options.relationship ?? "operator";
      return [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
          relationship,
          status: "active",
        },
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          relationship,
          status: "active",
        },
      ];
    },
  };
  return buildApp({
    logger: false,
    bookingModuleRepository: options.repository ?? createRepository(),
    pmsOperationsAllowedOrigins: options.allowedOrigins,
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
          return (
            options.permissions ?? [
              "booking.addons.read",
              "booking.addons.manage",
              "booking.promos.read",
              "booking.promos.manage",
            ]
          );
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return [
            {
              product: "pms",
              key: "property-management",
              status: "active",
              resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
            },
          ];
        },
      },
    },
  });
}

describe("Booking Engine module routes", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("lists both switches from the booking settings for an operator who manages them", async () => {
    app = buildAuthenticatedApp({
      repository: createRepository({ "add-ons": true, promos: false, updatedAt: now }),
    });

    const response = await app.inject({ method: "GET", url, headers });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json<BookingModulesResponse>()).toEqual({
      hotelId: propertyId,
      canManage: true,
      supportedModules: ["add-ons", "promos"],
      activeModules: ["add-ons"],
      activations: [
        {
          moduleId: "add-ons",
          isActive: true,
          activatedAt: null,
          deactivatedAt: null,
          updatedAt: now,
        },
        {
          moduleId: "promos",
          isActive: false,
          activatedAt: null,
          deactivatedAt: null,
          updatedAt: now,
        },
      ],
      manageableModules: ["add-ons", "promos"],
    });
  });

  it("counts both modules as on, but not switchable, before booking settings exist", async () => {
    const repository = createRepository(null);
    app = buildAuthenticatedApp({ repository });

    const read = await injectJson<BookingModulesResponse>(app, { method: "GET", url, headers });
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({
      canManage: false,
      activeModules: ["add-ons", "promos"],
      activations: [],
      manageableModules: [],
    });

    const write = await app.inject({
      method: "PATCH",
      url: `${url}/promos`,
      headers,
      payload: { isActive: false },
    });
    expect(write.statusCode).toBe(409);
    expect(write.json()).toMatchObject({ code: "booking_settings_missing" });
  });

  it("lets each module be switched only with its own Booking Engine permission", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({
      repository,
      permissions: ["booking.addons.read", "booking.addons.manage", "booking.promos.read"],
    });

    const read = await injectJson<BookingModulesResponse>(app, { method: "GET", url, headers });
    expect(read.body).toMatchObject({ canManage: true, manageableModules: ["add-ons"] });

    const promos = await app.inject({
      method: "PATCH",
      url: `${url}/promos`,
      headers,
      payload: { moduleId: "promos", isActive: false },
    });
    expect(promos.statusCode).toBe(403);

    const addOns = await app.inject({
      method: "PATCH",
      url: `${url}/add-ons`,
      headers,
      payload: { moduleId: "add-ons", isActive: false },
    });
    expect(addOns.statusCode).toBe(200);
    expect(addOns.headers["cache-control"]).toBe("no-store");
    expect(addOns.json<BookingModule>()).toMatchObject({ moduleId: "add-ons", isActive: false });
    expect(repository.updates).toEqual([{ propertyId, moduleId: "add-ons", isActive: false }]);
  });

  it("lets front desk staff read the switches but not change them", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({
      repository,
      permissions: ["pms.operations.read", "booking.addons.manage"],
      relationship: "front_desk",
    });

    const read = await injectJson<BookingModulesResponse>(app, { method: "GET", url, headers });
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ canManage: false, manageableModules: [] });

    const write = await app.inject({
      method: "PATCH",
      url: `${url}/add-ons`,
      headers,
      payload: { isActive: false },
    });
    expect(write.statusCode).toBe(403);
    expect(repository.updates).toEqual([]);
  });

  it("refuses readers without a matching permission and unauthenticated requests", async () => {
    app = buildAuthenticatedApp({ permissions: ["pms.finance.read"] });
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `${url}/unknown`,
          payload: { isActive: true },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("rejects modules it does not own and malformed bodies before writing", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({ repository });

    for (const [path, payload] of [
      ["inbox", { isActive: true }],
      ["affiliates", { isActive: true }],
      ["promos", { isActive: "yes" }],
      ["promos", { moduleId: "add-ons", isActive: true }],
    ] as const) {
      const response = await app.inject({
        method: "PATCH",
        url: `${url}/${path}`,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/pms/properties/nope/booking-modules",
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.updates).toEqual([]);
  });

  it("reports storage failures as unavailable", async () => {
    const repository = createRepository();
    repository.fail = true;
    app = buildAuthenticatedApp({ repository });

    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(503);
    const write = await app.inject({
      method: "PATCH",
      url: `${url}/promos`,
      headers,
      payload: { isActive: false },
    });
    expect(write.statusCode).toBe(503);
  });

  it("answers allowed browser origins and refuses others", async () => {
    app = buildAuthenticatedApp({ allowedOrigins: ["https://pms.vayada.com"] });

    const allowed = await app.inject({
      method: "OPTIONS",
      url: `${url}/promos`,
      headers: { origin: "https://pms.vayada.com" },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-methods"]).toBe("GET,PATCH,OPTIONS");

    const refused = await app.inject({
      method: "GET",
      url,
      headers: { ...headers, origin: "https://evil.example" },
    });
    expect(refused.statusCode).toBe(403);
  });
});
