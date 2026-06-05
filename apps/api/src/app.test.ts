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
import {
  createPgBookingSettingsReadRepository,
  type BookingSettingsReadRepository,
} from "./routes/bookingSettings.js";
import {
  toReservationResponse,
  type BookingReservationReadModel,
  type BookingReservationsReadRepository,
} from "./routes/bookingReservations.js";

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

const bookingSettingsRepository: BookingSettingsReadRepository = {
  async findAddonSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      showAddonsStep: false,
      groupAddonsByCategory: true,
    };
  },
};

const reservation: BookingReservationReadModel = {
  id: "reservation_1",
  bookingReference: "VAY-2026-0001",
  roomTypeId: "room_type_suite",
  roomName: "Suite",
  roomMaxOccupancy: 2,
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.com",
  guestPhone: "+15555550123",
  guestCountry: "GB",
  guestGender: "",
  guestDateOfBirth: null,
  guestPassportNumber: "",
  specialRequests: "Late arrival",
  estimatedArrivalTime: "21:00",
  numberOfGuests: 2,
  checkIn: "2026-07-10",
  checkOut: "2026-07-12",
  adults: 2,
  children: 0,
  nightlyRate: "120.50",
  numberOfRooms: 2,
  totalAmount: "241.00",
  currency: "EUR",
  status: "confirmed",
  roomId: "room_101",
  roomNumber: "101",
  assignedRooms: [{ roomId: "room_102", roomNumber: "102", position: 1 }],
  channel: "direct",
  paymentMethod: "card",
  paymentStatus: "captured",
  depositRequired: false,
  depositPercentage: null,
  depositAmount: "0",
  balanceAmount: "241.00",
  checkInPendingFlags: [],
  checkedInAt: null,
  checkedOutAt: null,
  hostResponseDeadline: null,
  platformFeeAmount: null,
  affiliateCommissionAmount: null,
  propertyPayoutAmount: null,
  addonIds: ["addon_breakfast"],
  addonNames: ["Breakfast"],
  addonTotal: "30.00",
  addonQuantities: { addon_breakfast: 2 },
  addonDates: { addon_breakfast: ["2026-07-10"] },
  guestWithdrawn: false,
  promoCode: null,
  promoDiscount: "0",
  lastMinuteDiscountPercent: "0",
  lastMinuteDiscountAmount: "0",
  createdAt: "2026-06-01T12:00:00.000Z",
  updatedAt: "2026-06-02T12:00:00.000Z",
};

const bookingReservationsRepository: BookingReservationsReadRepository = {
  async listReservationsByHotelId(hotelId, filters) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    expect(filters).toEqual({
      status: undefined,
      search: undefined,
      limit: 50,
      offset: 0,
    });

    return {
      reservations: [reservation],
      total: 1,
    };
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
    reservationsRepository?: BookingReservationsReadRepository;
    settingsRepository?: BookingSettingsReadRepository;
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    bookingReservationsRepository: options.reservationsRepository ?? bookingReservationsRepository,
    bookingSettingsRepository: options.settingsRepository ?? bookingSettingsRepository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepositoryWithHotel(options.linkedHotelId),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["booking.settings.manage", "booking.reservation.read"];
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

  it("does not expose booking addon settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose booking reservations until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
    });

    expect(response.statusCode).toBe(404);
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

  it("returns booking addon settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      showAddonsStep: false,
      groupAddonsByCategory: true,
    });
  });

  it("returns booking reservations with auth, policy, and the documented product list shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookings: [
        {
          id: "reservation_1",
          bookingReference: "VAY-2026-0001",
          roomTypeId: "room_type_suite",
          roomName: "Suite",
          roomMaxOccupancy: 2,
          totalRoomCapacity: 4,
          guestFirstName: "Ada",
          guestLastName: "Lovelace",
          guestEmail: "ada@example.com",
          guestPhone: "+15555550123",
          guestCountry: "GB",
          guestGender: "",
          guestDateOfBirth: null,
          guestPassportNumber: "",
          specialRequests: "Late arrival",
          estimatedArrivalTime: "21:00",
          numberOfGuests: 2,
          checkIn: "2026-07-10",
          checkOut: "2026-07-12",
          nights: 2,
          adults: 2,
          children: 0,
          nightlyRate: 120.5,
          numberOfRooms: 2,
          totalAmount: 241,
          currency: "EUR",
          status: "confirmed",
          roomId: "room_101",
          roomNumber: "101",
          assignedRooms: [
            {
              roomId: "room_101",
              roomNumber: "101",
              position: 0,
            },
            {
              roomId: "room_102",
              roomNumber: "102",
              position: 1,
            },
          ],
          channel: "direct",
          paymentMethod: "card",
          paymentStatus: "captured",
          depositRequired: false,
          depositPercentage: null,
          depositAmount: 0,
          balanceAmount: 241,
          checkInPendingFlags: [],
          checkedInAt: null,
          checkedOutAt: null,
          hostResponseDeadline: null,
          platformFeeAmount: null,
          affiliateCommissionAmount: null,
          propertyPayoutAmount: null,
          addonIds: ["addon_breakfast"],
          addonNames: ["Breakfast"],
          addonTotal: 30,
          addonQuantities: { addon_breakfast: 2 },
          addonDates: { addon_breakfast: ["2026-07-10"] },
          guestWithdrawn: false,
          promoCode: null,
          promoDiscount: 0,
          lastMinuteDiscountPercent: 0,
          lastMinuteDiscountAmount: 0,
          createdAt: "2026-06-01T12:00:00.000Z",
          updatedAt: "2026-06-02T12:00:00.000Z",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  it("sanitizes invalid reservation numeric and date values from read models", () => {
    const response = toReservationResponse({
      ...reservation,
      roomMaxOccupancy: Number.NaN,
      nightlyRate: "N/A",
      totalAmount: "",
      depositAmount: "not-a-number",
      balanceAmount: Number.POSITIVE_INFINITY,
      checkedInAt: "not-a-date",
      createdAt: "not-a-date",
      updatedAt: new Date("not-a-date"),
    });

    expect(response.roomMaxOccupancy).toBe(1);
    expect(response.totalRoomCapacity).toBe(2);
    expect(response.nightlyRate).toBe(0);
    expect(response.totalAmount).toBe(0);
    expect(response.depositAmount).toBe(0);
    expect(response.balanceAmount).toBe(0);
    expect(response.checkedInAt).toBeNull();
    expect(response.createdAt).toBe("");
    expect(response.updatedAt).toBe("");
  });

  it("returns an empty booking reservation list for an authorized hotel with no rows", async () => {
    app = buildAuthenticatedApp({
      reservationsRepository: {
        async listReservationsByHotelId() {
          return {
            reservations: [],
            total: 0,
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookings: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it("rejects empty booking settings repository connection strings", async () => {
    expect(() => createPgBookingSettingsReadRepository({ connectionString: " " })).toThrow(
      "Booking settings repository connectionString must not be empty",
    );
  });

  it("defaults missing booking addon settings fields to the legacy response defaults", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return {};
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      showAddonsStep: true,
      groupAddonsByCategory: true,
    });
  });

  it("rejects booking addon settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects booking addon settings with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects booking addon settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects booking addon settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects booking addon settings when entitlement is suspended", async () => {
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
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects booking addon settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects booking reservations without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects booking reservations with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects booking reservations when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: ["booking.settings.manage"] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects booking reservations when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects booking reservations when entitlement is suspended", async () => {
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
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects booking reservations when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 404 when the authorized booking hotel has no settings record", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(404);
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
