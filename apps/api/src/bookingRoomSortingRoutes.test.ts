import type { LinkedResource, PermissionKey, ProductEntitlement } from "@vayada/backend-auth";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { actorUserId, now, organizationId, propertyId } from "./bookingGuestPolicyTestFixtures.js";
import {
  DEFAULT_ROOM_SORTING,
  guestRoomSorting,
  parseRoomSorting,
  storedRoomSorting,
  type BookingRoomSortingRepository,
  type RoomSorting,
} from "./domains/bookingRoomSorting.js";
import { registerBookingRoomSortingRoutes } from "./routes/bookingRoomSorting.js";

// VAY-2449: Booking Admin › Settings › Room Sorting.
const custom: RoomSorting = {
  enabled: true,
  hideWithOneRoom: false,
  options: [
    { key: "priceLow", enabled: true },
    { key: "recommended", enabled: true },
    { key: "capacity", enabled: true },
    { key: "priceHigh", enabled: false },
    { key: "roomSize", enabled: false },
    { key: "bestDeal", enabled: false },
  ],
  defaultOption: "capacity",
};

describe("Room sorting values", () => {
  it("defaults to today's four options, Recommended first and default, hidden for one room", () => {
    expect(DEFAULT_ROOM_SORTING).toEqual({
      enabled: true,
      hideWithOneRoom: true,
      options: [
        { key: "recommended", enabled: true },
        { key: "priceLow", enabled: true },
        { key: "priceHigh", enabled: true },
        { key: "roomSize", enabled: true },
        { key: "capacity", enabled: false },
        { key: "bestDeal", enabled: false },
      ],
      defaultOption: "recommended",
    });
    expect(parseRoomSorting(DEFAULT_ROOM_SORTING)).toEqual(DEFAULT_ROOM_SORTING);
  });

  it("gives guests the shown options in the saved order", () => {
    expect(guestRoomSorting(custom)).toEqual({
      enabled: true,
      hideWithOneRoom: false,
      options: ["priceLow", "recommended", "capacity"],
      defaultOption: "capacity",
    });
  });

  it("takes every option once, at least one shown, and a shown default", () => {
    const options = custom.options;
    for (const invalid of [
      null,
      [],
      { ...custom, extra: true },
      { ...custom, enabled: "yes" },
      { ...custom, hideWithOneRoom: undefined },
      { ...custom, options: options.slice(1) },
      { ...custom, options: [...options.slice(1), options[1]] },
      { ...custom, options: [...options.slice(1), { key: "cheapest", enabled: true }] },
      { ...custom, options: [...options.slice(1), { key: "priceLow", enabled: 1 }] },
      { ...custom, options: [...options.slice(1), { ...options[0], label: "x" }] },
      { ...custom, options: options.map((option) => ({ ...option, enabled: false })) },
      { ...custom, defaultOption: "priceHigh" },
      { ...custom, defaultOption: "cheapest" },
    ])
      expect(parseRoomSorting(invalid), JSON.stringify(invalid)).toBeNull();
    // Off keeps its options: the menu comes back as it was when the hotel turns it on again.
    expect(parseRoomSorting({ ...custom, enabled: false })).toEqual({ ...custom, enabled: false });
  });

  it("reads a saved value leniently, so a later shape keeps what the hotel chose", () => {
    expect(storedRoomSorting(custom)).toEqual(custom);
    expect(
      storedRoomSorting({
        enabled: false,
        future: "field",
        options: [
          { key: "priceHigh", enabled: true, label: "x" },
          { key: "cheapest", enabled: true },
          { key: "priceHigh", enabled: false },
          { key: "capacity", enabled: true },
        ],
        defaultOption: "cheapest",
      }),
    ).toEqual({
      enabled: false,
      hideWithOneRoom: true,
      options: [
        { key: "priceHigh", enabled: true },
        { key: "capacity", enabled: true },
        { key: "recommended", enabled: false },
        { key: "priceLow", enabled: false },
        { key: "roomSize", enabled: false },
        { key: "bestDeal", enabled: false },
      ],
      defaultOption: "priceHigh",
    });
    for (const nothingShown of [
      null,
      [],
      "on",
      {},
      { options: [{ key: "priceLow", enabled: false }] },
    ])
      expect(storedRoomSorting(nothingShown)).toBeNull();
  });
});

describe("Booking room sorting routes", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });
  const url = `/properties/${propertyId}/room-sorting`;
  const headers = { authorization: "Bearer valid-token" };

  it("reads the settings and saves them with the caller's audit scope", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);

    const read = await app.inject({ method: "GET", url, headers });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("private, no-store");
    expect(read.json()).toEqual({
      sorting: DEFAULT_ROOM_SORTING,
      defaults: DEFAULT_ROOM_SORTING,
      canSave: true,
    });
    expect(repository.read).toHaveBeenCalledWith(propertyId);

    const saved = await app.inject({ method: "PUT", url, headers, payload: custom });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers["cache-control"]).toBe("no-store");
    expect(saved.json()).toEqual({ sorting: custom });
    expect(repository.save).toHaveBeenCalledWith({
      propertyId,
      sorting: custom,
      audit: {
        actorUserId,
        organizationId,
        requestId: "request-1",
        correlationId: "correlation-1",
      },
    });
  });

  it("refuses an invalid list, a missing hotel and a hotel without booking settings", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);
    for (const payload of [
      {},
      { ...custom, defaultOption: "priceHigh" },
      { ...custom, options: custom.options.slice(1) },
      { ...custom, propertyId },
    ]) {
      const refused = await app.inject({ method: "PUT", url, headers, payload });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: "invalid_room_sorting" });
    }
    expect(repository.save).not.toHaveBeenCalled();

    repository.save.mockResolvedValueOnce(null);
    const missing = await app.inject({ method: "PUT", url, headers, payload: custom });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toEqual({
      code: "booking_settings_missing",
      message: "Set up the booking engine before choosing how guests sort rooms.",
    });

    repository.read.mockResolvedValueOnce(null);
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);

    repository.read.mockRejectedValueOnce(new Error("database down"));
    const failed = await app.inject({ method: "GET", url, headers });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ code: "room_sorting_unavailable" });

    repository.save.mockRejectedValueOnce(new Error("database down"));
    const failedSave = await app.inject({ method: "PUT", url, headers, payload: custom });
    expect(failedSave.statusCode).toBe(503);
  });

  it("needs a signed-in member who manages the hotel's booking settings", async () => {
    const repository = repositoryFake();
    app = await routeApp(repository);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url, payload: custom })).statusCode).toBe(401);
    await app.close();

    app = await routeApp(repository, ["booking.settings.read" as PermissionKey]);
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url, headers, payload: custom })).statusCode).toBe(
      403,
    );
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });
});

function repositoryFake() {
  return {
    read: vi.fn<BookingRoomSortingRepository["read"]>(async () => ({
      sorting: DEFAULT_ROOM_SORTING,
      defaults: DEFAULT_ROOM_SORTING,
      canSave: true,
    })),
    save: vi.fn<BookingRoomSortingRepository["save"]>(async ({ sorting }) => sorting),
  };
}

async function routeApp(
  repository: BookingRoomSortingRepository,
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
  await app.register(registerBookingRoomSortingRoutes, {
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
