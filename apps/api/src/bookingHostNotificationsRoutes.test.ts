import type { LinkedResource, PermissionKey, ProductEntitlement } from "@vayada/backend-auth";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  actorUserId,
  now,
  organizationId,
  otherPropertyId,
  propertyId,
} from "./bookingGuestPolicyTestFixtures.js";
import type {
  BookingHostNotificationsRepository,
  HostNotificationFeed,
} from "./domains/bookingHostNotifications.js";
import { registerBookingHostNotificationRoutes } from "./routes/bookingHostNotifications.js";

// VAY-2349: Booking Admin's notifications bell.
const feed: HostNotificationFeed = {
  generatedAt: "2026-10-25T12:00:00.000Z",
  timeZone: "Europe/Berlin",
  items: [],
  syncAlert: null,
  unread: { all: 0, bookings: 0, needsAction: 0, updates: 0 },
  badge: "none",
};
const key = "booking-event:e0000001-0000-4000-8000-000000000000";

describe("Booking Admin notification routes", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });
  const url = `/properties/${propertyId}/notifications`;
  const headers = { authorization: "Bearer valid-token" };

  it("reads the property's feed for the signed-in person, with what they may see", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository, {
      permissions: [
        "booking.reservation.read",
        "booking.promos.read",
        "pms.operations.manage",
        "pms.operations.read",
      ],
      pms: true,
      syncRetryDomains: ["ari"],
    });

    const read = await app.inject({ method: "GET", url, headers });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("private, no-store");
    expect(read.json()).toEqual(feed);
    expect(repository.read).toHaveBeenCalledWith(propertyId, {
      userId: actorUserId,
      organizationId,
      canReadPromos: true,
      canReadGuestContact: false,
      retrySyncDomains: ["ari"],
      canOpenChannelManager: true,
    });
    await app.close();

    // Retry sync needs the PMS permission and the PMS product for this property.
    app = await routeApp(repository, {
      permissions: ["booking.reservation.read", "pms.guest_contact.read", "pms.operations.manage"],
      syncRetryDomains: ["ari"],
    });
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(200);
    expect(repository.read).toHaveBeenLastCalledWith(propertyId, {
      userId: actorUserId,
      organizationId,
      canReadPromos: false,
      canReadGuestContact: true,
      retrySyncDomains: [],
      canOpenChannelManager: false,
    });
  });

  it("marks notifications read, one by one or all at once", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);

    const one = await app.inject({
      method: "POST",
      url: `${url}/read`,
      headers,
      payload: { keys: [key] },
    });
    expect(one.statusCode).toBe(204);
    expect(repository.markRead).toHaveBeenCalledWith(propertyId, actorUserId, [key]);

    const all = await app.inject({
      method: "POST",
      url: `${url}/read-all`,
      headers,
      payload: { before: "2026-10-25T12:00:00.000Z", syncAlertKey: "channel-sync:c:ari.1" },
    });
    expect(all.statusCode).toBe(204);
    expect(repository.markAllRead).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({ userId: actorUserId, organizationId }),
      { before: new Date("2026-10-25T12:00:00.000Z"), syncAlertKey: "channel-sync:c:ari.1" },
    );
    for (const payload of [{}, { before: "yesterday" }, { before: feed.generatedAt, extra: 1 }])
      expect(
        (await app.inject({ method: "POST", url: `${url}/read-all`, headers, payload })).statusCode,
      ).toBe(400);

    repository.markRead.mockClear();
    for (const payload of [
      {},
      { keys: [] },
      { keys: ["not a key"] },
      { keys: [key], propertyId },
      { keys: Array.from({ length: 101 }, () => key) },
    ])
      expect(
        (await app.inject({ method: "POST", url: `${url}/read`, headers, payload })).statusCode,
      ).toBe(400);
    expect(repository.markRead).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing property and 503 when the database fails", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);
    repository.read.mockResolvedValueOnce(null);
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
    repository.read.mockRejectedValueOnce(new Error("database down"));
    const failed = await app.inject({ method: "GET", url, headers });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ code: "notifications_unavailable" });
    repository.markAllRead.mockRejectedValueOnce(new Error("database down"));
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${url}/read-all`,
          headers,
          payload: { before: feed.generatedAt },
        })
      ).statusCode,
    ).toBe(503);
  });

  it("needs a signed-in member who may read the property's reservations", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/properties/not-a-uuid/notifications", headers }))
        .statusCode,
    ).toBe(400);
    await app.close();

    app = await routeApp(repository, { permissions: ["booking.settings.read"] });
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${url}/read`,
          headers,
          payload: { keys: [key] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${url}/read-all`,
          headers,
          payload: { before: feed.generatedAt },
        })
      ).statusCode,
    ).toBe(403);
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.markRead).not.toHaveBeenCalled();
    expect(repository.markAllRead).not.toHaveBeenCalled();
  });

  it("refuses a property the member isn't assigned to", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository, { assignedPropertyIds: [otherPropertyId] });
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
    expect(repository.read).not.toHaveBeenCalled();
  });
});

function repositoryFake() {
  return {
    read: vi.fn<BookingHostNotificationsRepository["read"]>(async () => feed),
    markRead: vi.fn<BookingHostNotificationsRepository["markRead"]>(async () => {}),
    markAllRead: vi.fn<BookingHostNotificationsRepository["markAllRead"]>(async () => {}),
  };
}

async function routeApp(
  repository: BookingHostNotificationsRepository,
  options: {
    permissions?: readonly string[];
    pms?: boolean;
    syncRetryDomains?: ("ari" | "booking")[];
    assignedPropertyIds?: string[];
  } = {},
) {
  const permissions = (options.permissions ?? ["booking.reservation.read"]) as PermissionKey[];
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
        permissions,
      },
      linkedResources: links(options.pms === true),
      entitlements: entitlements(options.pms === true),
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
  await app.register(registerBookingHostNotificationRoutes, {
    repository,
    syncRetryDomains: options.syncRetryDomains ?? [],
    propertyAccessRepository: {
      findMembershipPropertyScope: vi.fn(async () =>
        options.assignedPropertyIds
          ? {
              mode: "assigned" as const,
              roleKey: "front_desk",
              accessOrigin: "agency" as const,
              assignedPropertyIds: options.assignedPropertyIds,
            }
          : {
              mode: "all" as const,
              roleKey: "hotel_manager",
              accessOrigin: "agency" as const,
              assignedPropertyIds: [],
            },
      ),
    },
  });
  return app;
}

function entitlements(pms: boolean): ProductEntitlement[] {
  return [
    {
      product: "booking",
      key: "booking-engine",
      status: "active",
      resource: { product: "booking", resourceType: "booking_hotel", resourceId: propertyId },
    },
    ...(pms
      ? [
          {
            product: "pms",
            key: "property-management",
            status: "active",
            resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
          } satisfies ProductEntitlement,
        ]
      : []),
  ];
}

function links(pms: boolean): LinkedResource[] {
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
    ...(pms
      ? [
          {
            product: "pms",
            resourceType: "pms_property",
            resourceId: propertyId,
            relationship: "owner",
            status: "active",
          } satisfies LinkedResource,
        ]
      : []),
  ];
}
