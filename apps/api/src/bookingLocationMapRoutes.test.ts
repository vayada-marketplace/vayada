import type { LinkedResource, PermissionKey, ProductEntitlement } from "@vayada/backend-auth";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { actorUserId, now, organizationId, propertyId } from "./bookingGuestPolicyTestFixtures.js";
import type {
  BookingLocationMapRepository,
  LocationMapSummary,
} from "./domains/bookingLocationMap.js";
import { registerBookingLocationMapRoutes } from "./routes/bookingLocationMap.js";

// VAY-2126: Booking Admin's "Location map on your booking page" switch.
const summary: LocationMapSummary = {
  enabled: false,
  nearbyEnabled: false,
  canSwitch: true,
  rooms: [
    {
      roomTypeId: "11111111-1111-4111-8111-111111111111",
      name: "Schwabing Loft",
      address: "Leopoldstraße 12, Munich",
      pin: { latitude: 48.15634, longitude: 11.58242 },
      atProperty: false,
      approximate: false,
    },
  ],
  property: {
    name: "Alpenrose Apartments",
    address: "Maximilianstraße 3, 80539 Munich",
    pin: { latitude: 48.1394, longitude: 11.5835 },
    mapDisplayMode: "exact",
  },
};

describe("Booking location map routes", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });
  const url = `/properties/${propertyId}/location-map`;
  const headers = { authorization: "Bearer valid-token" };

  it("reads the summary and saves the switch with the caller's audit scope", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);

    const read = await app.inject({ method: "GET", url, headers });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("private, no-store");
    expect(read.json()).toEqual(summary);
    expect(repository.read).toHaveBeenCalledWith(propertyId);

    const saved = await app.inject({ method: "PUT", url, headers, payload: { enabled: true } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ enabled: true });
    expect(repository.setEnabled).toHaveBeenCalledWith({
      propertyId,
      enabled: true,
      audit: {
        actorUserId,
        organizationId,
        requestId: "request-1",
        correlationId: "correlation-1",
      },
    });
  });

  it("saves Show nearby places on its own route, with the same checks (VAY-2326)", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);
    const nearby = `${url}/nearby`;

    const saved = await app.inject({
      method: "PUT",
      url: nearby,
      headers,
      payload: { enabled: true },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers["cache-control"]).toBe("no-store");
    expect(saved.json()).toEqual({ enabled: true });
    expect(repository.setEnabled).toHaveBeenCalledWith({
      propertyId,
      enabled: true,
      setting: "nearbyPlaces",
      audit: {
        actorUserId,
        organizationId,
        requestId: "request-1",
        correlationId: "correlation-1",
      },
    });

    repository.setEnabled.mockClear();
    for (const payload of [{}, { enabled: "on" }, { enabled: true, setting: "locationMap" }])
      expect((await app.inject({ method: "PUT", url: nearby, headers, payload })).statusCode).toBe(
        400,
      );
    expect(repository.setEnabled).not.toHaveBeenCalled();
    repository.setEnabled.mockResolvedValueOnce(null);
    const missing = await app.inject({
      method: "PUT",
      url: nearby,
      headers,
      payload: { enabled: true },
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toEqual({
      code: "booking_settings_missing",
      message: "Set up the booking engine before showing nearby places.",
    });
    await app.close();

    app = await routeApp(repository, ["booking.settings.read" as PermissionKey]);
    expect(
      (await app.inject({ method: "PUT", url: nearby, headers, payload: { enabled: true } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "PUT", url: nearby, payload: { enabled: true } })).statusCode,
    ).toBe(401);
  });

  it("refuses other fields, a missing hotel and a hotel without booking settings", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);
    for (const payload of [{}, { enabled: "yes" }, { enabled: true, propertyId }])
      expect((await app.inject({ method: "PUT", url, headers, payload })).statusCode).toBe(400);
    expect(repository.setEnabled).not.toHaveBeenCalled();

    repository.setEnabled.mockResolvedValueOnce(null);
    const missing = await app.inject({ method: "PUT", url, headers, payload: { enabled: true } });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: "booking_settings_missing" });

    repository.read.mockResolvedValueOnce(null);
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);

    repository.read.mockRejectedValueOnce(new Error("database down"));
    const failed = await app.inject({ method: "GET", url, headers });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ code: "location_map_unavailable" });
  });

  it("needs a signed-in member who manages the hotel's booking settings", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    await app.close();

    app = await routeApp(repository, ["booking.settings.read" as PermissionKey]);
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "PUT", url, headers, payload: { enabled: true } })).statusCode,
    ).toBe(403);
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.setEnabled).not.toHaveBeenCalled();
  });
});

function repositoryFake() {
  return {
    read: vi.fn<BookingLocationMapRepository["read"]>(async () => summary),
    setEnabled: vi.fn<BookingLocationMapRepository["setEnabled"]>(async ({ enabled }) => ({
      enabled,
    })),
  };
}

async function routeApp(
  repository: BookingLocationMapRepository,
  permissions: readonly PermissionKey[] = ["booking.settings.manage"],
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: {
        internalUserId: actorUserId,
        providerIdentity: { provider: "workos", providerUserId: "user_staff" },
        email: "staff@example.com",
        status: "active",
      },
      selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
      membership: {
        membershipId: "723e4567-e89b-42d3-a456-426614174000",
        status: "active",
        roleKey: "hotel_manager",
        workosRoleSlugs: ["hotel_admin"],
        permissions: [...permissions],
      },
      linkedResources: links(),
      entitlements: [entitlement()],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: now,
      },
    };
  });
  await app.register(registerBookingLocationMapRoutes, {
    repository,
    propertyAccessRepository: {
      findMembershipPropertyScope: vi.fn(async () => ({
        mode: "all" as const,
        roleKey: "hotel_manager",
        accessOrigin: "agency" as const,
        assignedPropertyIds: [],
      })),
    },
  });
  return app;
}

function entitlement(): ProductEntitlement {
  return {
    product: "booking",
    key: "booking-engine",
    status: "active",
    resource: { product: "booking", resourceType: "booking_hotel", resourceId: propertyId },
  };
}

function links(): LinkedResource[] {
  return [
    {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      relationship: "owner",
      status: "active",
    },
    {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: propertyId,
      relationship: "owner",
      status: "active",
    },
  ];
}
