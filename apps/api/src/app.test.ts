import {
  createFakeVerifier,
  requireAuthContext,
  type ProductEntitlement,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { findForbiddenPublicBookabilityKeys } from "@vayada/domain-distribution";
import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import type { QueryResult, QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCompatibilityPublicHotelQuoteRepository,
  serializePublicHotelQuoteProjection,
  toUnavailablePublicHotelQuoteProjection,
  type PublicHotelQuoteRepository,
} from "./routes/aiHotelQuotes.js";
import { buildApp } from "./app.js";
import {
  serializePublicHotelProfileProjection,
  toPublicHotelProfileProjection,
  type PublicHotelProfileRepository,
} from "./routes/aiHotels.js";
import {
  createPgBookingSettingsReadRepository,
  type BookingSettingsReadRepository,
} from "./routes/bookingSettings.js";
import {
  createCompatibilityPmsBookingReservationsReadRepository,
  toReservationResponse,
  type BookingReservationsReadPool,
  type BookingReservationListFilters,
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
  async findGuestFormSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      specialRequestsEnabled: false,
      arrivalTimeEnabled: true,
      guestCountEnabled: true,
    };
  },
  async findBenefitsSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      benefits: ["Free breakfast", "Late checkout"],
    };
  },
  async findLocalizationSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      defaultCurrency: "CHF",
      defaultLanguage: "de",
      supportedCurrencies: ["CHF", "EUR"],
      supportedLanguages: ["de", "en"],
    };
  },
  async findRoomFilterSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      bookingFilters: ["oceanView", "spa_access"],
      customFilters: {
        spa_access: "Spa access",
      },
      filterRooms: {
        oceanView: ["room_101", "room_102"],
        spa_access: ["room_102"],
      },
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

const seededPublicProfile = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "bookable",
)!.profile;
const seededPublicQuote = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "bookable",
)!.quote!;
const seededUnavailableQuote = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "unavailable",
)!.quote!;

const publicHotelProfileRepository: PublicHotelProfileRepository = {
  async findProfileBySlug(slug) {
    return slug === seededPublicProfile.hotel.slug ? seededPublicProfile : null;
  },
};

const publicHotelQuoteRepository: PublicHotelQuoteRepository = {
  async findQuoteBySlug(slug, query) {
    if (slug !== seededPublicQuote.request.hotelSlug) return null;
    if (query.check_in === "2026-09-12" && query.check_out === "2026-09-15") {
      return seededPublicQuote;
    }
    return seededUnavailableQuote;
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

  it("does not expose booking guest-form settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose booking benefits settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose booking localization settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose booking room-filter settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
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

  it("does not expose public AI hotel profiles until a distribution read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose public AI hotel quotes until a distribution read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-09-12&check_out=2026-09-15&adults=2",
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns the public AI hotel profile contract from the distribution read model", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
    expect(response.headers["x-vayada-ratelimit-policy"]).toBe("public-ai-profile-read");
    expect(body).toMatchObject({
      contractVersion: "public-bookability.v1",
      publicVisibility: "public_safe",
      hotel: {
        slug: "hotel-alpenrose",
        canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
        timezone: "Europe/Vienna",
        defaultCurrency: "EUR",
        trust: {
          profileComplete: true,
          profileVerified: true,
          bookabilityStatus: "bookable",
        },
      },
      dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
    });
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("returns the public AI hotel quote contract from the distribution read model", async () => {
    app = buildApp({
      logger: false,
      publicHotelQuoteRepository,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&currency=EUR&locale=en&referral_code=creator-anna",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=15, stale-while-revalidate=60");
    expect(response.headers["x-vayada-ratelimit-policy"]).toBe("public-ai-quote-read");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
    expect(body).toMatchObject({
      contractVersion: "public-bookability.v1",
      publicVisibility: "public_safe",
      request: {
        hotelSlug: "hotel-alpenrose",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        nights: 3,
        adults: 2,
        currency: "EUR",
        locale: "en",
      },
      status: "bookable",
      quote: {
        priceGuarantee: "expires_at",
        offers: [
          {
            roomTypeId: "room_deluxe",
            totals: {
              roomTotal: 540,
              taxesAndFees: 54,
              grandTotal: 594,
            },
            paymentOptions: ["card", "pay_at_property"],
          },
        ],
      },
      deepLink: {
        url: "https://hotel-alpenrose.booking.localhost/en/book?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&referral_code=creator-anna&quote_id=quote_alpenrose_001",
      },
      dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
    });
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("returns stable unavailable reason codes for public AI hotel quotes", async () => {
    app = buildApp({
      logger: false,
      publicHotelQuoteRepository,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-10-01&check_out=2026-10-02&adults=2",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      status: "unavailable",
      unavailableReasons: [
        { code: "sold_out", detail: "No public inventory for requested dates." },
      ],
    });
    expect(body).not.toHaveProperty("quote");
  });

  it("builds bookable public AI quotes from the PMS public room-search adapter", async () => {
    const repository = createCompatibilityPublicHotelQuoteRepository({
      profileRepository: publicHotelProfileRepository,
      pmsPublicApiUrl: "https://api.pms.localhost",
      now: () => new Date("2026-06-06T11:00:00.000Z"),
      async fetch(input) {
        expect(input.toString()).toBe(
          "https://api.pms.localhost/api/hotels/hotel-alpenrose/rooms?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0",
        );

        return new Response(
          JSON.stringify([
            {
              id: "room_deluxe",
              name: "Deluxe Double Room",
              maxOccupancy: 3,
              maxAdults: 2,
              maxChildren: 1,
              nightlyRates: [180, 180, 180],
              nonRefundableNightlyRates: [162, 162, 162],
              currency: "EUR",
              remainingRooms: 3,
              flexibleRateEnabled: true,
              cancellationPolicy: "Free cancellation until 7 days before arrival.",
              nonRefundableCancellationPolicy: "Non-refundable from booking",
              ratePaymentMethods: {
                flexible: ["card", "pay_at_property"],
                nonrefundable: ["xendit", "pay_at_property", "bank_transfer"],
              },
              rateDepositSettings: {
                flexible: { enabled: false, percentage: null },
                nonrefundable: { enabled: true, percentage: 50 },
              },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
      children: "0",
      rooms: "1",
      currency: "EUR",
      locale: "en",
      referral_code: "creator-anna",
    });
    const serialized = serializePublicHotelQuoteProjection(quote!);

    expect(serialized).toMatchObject({
      status: "bookable",
      request: {
        hotelSlug: "hotel-alpenrose",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        nights: 3,
        adults: 2,
        rooms: 1,
        currency: "EUR",
        locale: "en",
      },
      quote: {
        expiresAt: "2026-06-06T11:15:00.000Z",
        priceGuarantee: "expires_at",
        offers: [
          {
            roomTypeId: "room_deluxe",
            ratePlanId: "flexible",
            totals: {
              roomTotal: 540,
              taxesAndFees: 0,
              discounts: 0,
              grandTotal: 540,
            },
            policies: {
              cancellation: "Free cancellation until 7 days before arrival.",
              deposit: "No deposit required.",
            },
            paymentOptions: ["card", "pay_at_property"],
          },
          {
            roomTypeId: "room_deluxe",
            ratePlanId: "nonrefundable",
            totals: {
              roomTotal: 486,
              grandTotal: 486,
            },
            policies: {
              cancellation: "Non-refundable from booking",
              deposit: "50% deposit required.",
            },
            paymentOptions: ["card", "bank_transfer"],
          },
        ],
      },
      deepLink: {
        expiresAt: "2026-06-06T11:15:00.000Z",
        preserves: ["dates", "guests", "rooms", "currency", "locale", "referral_code", "quote_id"],
      },
    });
    expect(serialized.deepLink!.url).toContain(
      "https://hotel-alpenrose.booking.localhost/en/book?",
    );
    expect(serialized.quote!.offers[0]!.bookingUrl).toContain("room_type=room_deluxe");
    expect(serialized.quote!.offers[0]!.bookingUrl).toContain("rate_plan=flexible");
    expect(findForbiddenPublicBookabilityKeys(serialized)).toEqual([]);
  });

  it("falls back to unavailable public AI quotes when PMS public API config is malformed", async () => {
    const repository = createCompatibilityPublicHotelQuoteRepository({
      profileRepository: publicHotelProfileRepository,
      pmsPublicApiUrl: "not a url",
      now: () => new Date("2026-06-06T11:00:00.000Z"),
      async fetch() {
        throw new Error("Malformed PMS URL should not reach fetch");
      },
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
      children: "0",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [
        { code: "unavailable_data", detail: "Public availability source is unavailable." },
      ],
    });
    expect(quote!.quote).toBeUndefined();
  });

  it("does not mark PMS multi-unit rooms bookable when requested room count cannot hold guests", async () => {
    const repository = createCompatibilityPublicHotelQuoteRepository({
      profileRepository: publicHotelProfileRepository,
      pmsPublicApiUrl: "https://api.pms.localhost",
      now: () => new Date("2026-06-06T11:00:00.000Z"),
      async fetch() {
        return new Response(
          JSON.stringify([
            {
              id: "room_family",
              name: "Family Room",
              maxOccupancy: 4,
              maxAdults: 4,
              maxChildren: 2,
              baseRate: 240,
              currency: "EUR",
              remainingRooms: 2,
              flexibleRateEnabled: true,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "6",
      children: "0",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: "unsupported_occupancy" }],
    });
    expect(quote!.quote).toBeUndefined();
  });

  it("does not return bookable public AI quote totals for promo codes before promo pricing is wired", async () => {
    let pmsCalled = false;
    const repository = createCompatibilityPublicHotelQuoteRepository({
      profileRepository: publicHotelProfileRepository,
      pmsPublicApiUrl: "https://api.pms.localhost",
      now: () => new Date("2026-06-06T11:00:00.000Z"),
      async fetch() {
        pmsCalled = true;
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
      currency: "EUR",
      locale: "en",
      promo_code: "SUMMER10",
    });

    expect(pmsCalled).toBe(false);
    expect(quote).toMatchObject({
      status: "unavailable",
      request: { promoCode: "SUMMER10" },
      unavailableReasons: [{ code: "promo_not_applicable" }],
    });
  });

  it("strips non-contract fields before returning public AI hotel quotes", async () => {
    const pollutedQuote = {
      ...seededPublicQuote,
      quote: {
        ...seededPublicQuote.quote!,
        providerAccountId: "acct_private",
        offers: [
          {
            ...seededPublicQuote.quote!.offers[0],
            internalRatePlanPayload: "private",
          },
        ],
      },
      debugPayload: { webhookPayload: "private" },
    } as unknown as typeof seededPublicQuote;
    app = buildApp({
      logger: false,
      publicHotelQuoteRepository: {
        async findQuoteBySlug() {
          return pollutedQuote;
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-09-12&check_out=2026-09-15&adults=2",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).not.toHaveProperty("debugPayload");
    expect(body.quote).not.toHaveProperty("providerAccountId");
    expect(body.quote.offers[0]).not.toHaveProperty("internalRatePlanPayload");
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("strips non-contract fields before returning public AI hotel profiles", async () => {
    const pollutedProfile = {
      ...seededPublicProfile,
      hotel: {
        ...seededPublicProfile.hotel,
        searchScore: 0.99,
        images: [
          {
            ...seededPublicProfile.hotel.images[0],
            internalCdnKey: "private",
          },
        ],
      },
      debugPayload: { providerAccountId: "acct_private" },
    } as unknown as typeof seededPublicProfile;
    app = buildApp({
      logger: false,
      publicHotelProfileRepository: {
        async findProfileBySlug() {
          return pollutedProfile;
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).not.toHaveProperty("debugPayload");
    expect(body.hotel).not.toHaveProperty("searchScore");
    expect(body.hotel.images[0]).not.toHaveProperty("internalCdnKey");
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("builds a public profile projection from the legacy Booking compatibility adapter", () => {
    const projection = toPublicHotelProfileProjection(
      {
        id: "booking_hotel_alpenrose",
        name: "Hotel Alpenrose",
        slug: "hotel-alpenrose",
        description: "A public alpine profile.",
        location: "Innsbruck",
        country: "AT",
        currency: "EUR",
        supported_currencies: ["USD"],
        hero_image: "https://cdn.vayada.example/hotel.jpg",
        images: ["https://cdn.vayada.example/room.jpg"],
        amenities: ["wifi", "breakfast"],
        check_in_time: "15:00",
        check_out_time: "11:00",
        timezone: "Europe/Vienna",
        default_language: "en",
        supported_languages: ["de"],
        custom_domain: "book.alpenrose.example",
        instant_book: true,
        online_card_payment: true,
        pay_at_property_enabled: true,
        free_cancellation_days: 7,
        terms_text: "Public terms",
        cancellation_policy_text: "",
        updated_at: "2026-06-06T10:00:00.000Z",
      },
      "2026-06-06T11:00:00.000Z",
    );

    expect(projection).toMatchObject({
      contractVersion: "public-bookability.v1",
      hotel: {
        propertyId: "booking_hotel_alpenrose",
        slug: "hotel-alpenrose",
        canonicalUrl: "https://book.alpenrose.example/en",
        bookingBaseUrl: "https://book.alpenrose.example",
        customDomainUrl: "https://book.alpenrose.example",
        timezone: "Europe/Vienna",
        defaultLocale: "en",
        supportedLocales: ["en", "de"],
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR", "USD"],
        location: { country: "AT", city: "Innsbruck" },
        capabilities: {
          instantBook: true,
          onlinePayment: true,
          payAtProperty: true,
        },
        trust: {
          profileComplete: true,
          profileVerified: true,
          domainVerified: true,
          bookabilityStatus: "unavailable",
          reasonCodes: ["unavailable_data"],
        },
      },
    });
    expect(serializePublicHotelProfileProjection(projection)).toEqual(projection);
  });

  it("normalizes invalid public AI quote requests through the compatibility adapter", () => {
    const projection = toUnavailablePublicHotelQuoteProjection(
      seededPublicProfile.hotel,
      {
        check_in: "2026-09-15",
        check_out: "2026-09-12",
        adults: "2",
        currency: "EUR",
        locale: "en",
      },
      new Date("2026-06-06T11:00:00.000Z"),
    );

    expect(projection).toMatchObject({
      status: "unavailable",
      request: {
        hotelSlug: "hotel-alpenrose",
        checkIn: "2026-09-15",
        checkOut: "2026-09-12",
        nights: 0,
        adults: 2,
        currency: "EUR",
        locale: "en",
      },
      unavailableReasons: [{ code: "invalid_request" }],
    });
    expect(serializePublicHotelQuoteProjection(projection)).toEqual(projection);
  });

  it("uses hotel quote limits for public AI quote unavailable reasons", () => {
    const projection = toUnavailablePublicHotelQuoteProjection(
      seededPublicProfile.hotel,
      {
        check_in: "2026-06-07",
        check_out: "2026-06-09",
        adults: "20",
        children: "1",
        rooms: "6",
        currency: "USD",
        locale: "it",
      },
      new Date("2026-06-06T11:00:00.000Z"),
    );

    expect(projection.unavailableReasons.map((reason) => reason.code)).toEqual([
      "unsupported_occupancy",
      "currency_not_supported",
      "locale_not_supported",
    ]);
    expect(findForbiddenPublicBookabilityKeys(projection)).toEqual([]);
  });

  it("normalizes same-property-day PMS sellout as same-day cutoff", async () => {
    const repository = createCompatibilityPublicHotelQuoteRepository({
      profileRepository: publicHotelProfileRepository,
      pmsPublicApiUrl: "https://api.pms.localhost",
      now: () => new Date("2026-06-06T11:00:00.000Z"),
      async fetch() {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-06-06",
      check_out: "2026-06-07",
      adults: "2",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: "same_day_cutoff_passed" }],
    });
  });

  it("does not silently default malformed public AI quote counts", () => {
    const projection = toUnavailablePublicHotelQuoteProjection(
      seededPublicProfile.hotel,
      {
        check_in: "2026-09-12",
        check_out: "2026-09-15",
        adults: "two",
        children: "-1",
        rooms: "1.5",
      },
      new Date("2026-06-06T11:00:00.000Z"),
    );

    expect(projection.unavailableReasons).toEqual([
      {
        code: "invalid_request",
        detail: "adults, children, and rooms must be non-negative integers.",
      },
    ]);
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

  it("returns booking guest-form settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      specialRequestsEnabled: false,
      arrivalTimeEnabled: true,
      guestCountEnabled: true,
    });
  });

  it("returns booking benefits settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: ["Free breakfast", "Late checkout"],
    });
  });

  it("returns booking localization settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      defaultCurrency: "CHF",
      defaultLanguage: "de",
      supportedCurrencies: ["CHF", "EUR"],
      supportedLanguages: ["de", "en"],
    });
  });

  it("returns booking room-filter settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: ["oceanView", "spa_access"],
      customFilters: {
        spa_access: "Spa access",
      },
      filterRooms: {
        oceanView: ["room_101", "room_102"],
        spa_access: ["room_102"],
      },
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

  it("applies booking reservation query defaults and coercion through the route", async () => {
    const observedFilters: BookingReservationListFilters[] = [];

    app = buildAuthenticatedApp({
      reservationsRepository: {
        async listReservationsByHotelId(hotelId, filters) {
          expect(hotelId).toBe("booking_hotel_alpenrose");
          observedFilters.push(filters);

          return {
            reservations: [],
            total: 0,
          };
        },
      },
    });

    const clampedResponse = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations?status=%20confirmed%20&search=%20Ada%20&limit=9999&offset=-5",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(clampedResponse.statusCode).toBe(200);
    expect(clampedResponse.body).toEqual({
      bookings: [],
      total: 0,
      limit: 500,
      offset: 0,
    });

    const defaultedResponse = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations?status=%20%20&search=%20%20&limit=not-a-number&offset=not-a-number",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(defaultedResponse.statusCode).toBe(200);
    expect(defaultedResponse.body).toEqual({
      bookings: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    expect(observedFilters).toEqual([
      {
        status: "confirmed",
        search: "Ada",
        limit: 500,
        offset: 0,
      },
      {
        status: undefined,
        search: undefined,
        limit: 50,
        offset: 0,
      },
    ]);
  });

  it("returns the booking reservation read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      reservationsRepository: {
        async listReservationsByHotelId() {
          throw new Error("database unavailable");
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

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking reservations are unavailable.",
    });
  });

  it("serves booking reservations from the configured compatibility read model", async () => {
    const queries: { text: string; values?: readonly unknown[] }[] = [];
    let poolClosed = false;
    const pool: BookingReservationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<Pick<QueryResult<T>, "rows">> {
        queries.push({ text, values });
        if (text.includes("COUNT(*)")) {
          return {
            rows: [{ total: "1" }] as unknown as T[],
          };
        }

        return {
          rows: [reservation] as unknown as T[],
        };
      },
      async end() {
        poolClosed = true;
      },
    };

    app = buildAuthenticatedApp({
      reservationsRepository: createCompatibilityPmsBookingReservationsReadRepository({
        connectionString: "postgresql://booking-reservations-read",
        pool,
      }),
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations?status=confirmed&search=Ada&limit=25&offset=5",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      bookings: [
        {
          id: "reservation_1",
          bookingReference: "VAY-2026-0001",
          roomName: "Suite",
          guestFirstName: "Ada",
          status: "confirmed",
        },
      ],
      total: 1,
      limit: 25,
      offset: 5,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain("FROM bookings b");
    expect(queries[0]?.text).toContain(
      "JOIN room_types rt ON rt.id = b.room_type_id AND rt.hotel_id = b.hotel_id",
    );
    expect(queries[0]?.text).toContain(
      "LEFT JOIN rooms rm ON rm.id = b.room_id AND rm.hotel_id = b.hotel_id",
    );
    expect(queries[0]?.text).toContain(
      "JOIN rooms brm ON brm.id = br.room_id AND brm.hotel_id = b.hotel_id",
    );
    expect(queries[0]?.values).toEqual(["booking_hotel_alpenrose", "confirmed", "%Ada%", 25, 5]);
    expect(queries[1]?.text).toContain("COUNT(*)");
    expect(queries[1]?.text).toContain(
      "JOIN room_types rt ON rt.id = b.room_type_id AND rt.hotel_id = b.hotel_id",
    );
    expect(queries[1]?.values).toEqual(["booking_hotel_alpenrose", "confirmed", "%Ada%"]);

    await app.close();
    app = null;
    expect(poolClosed).toBe(true);
  });

  it("rejects empty booking reservations repository connection strings", async () => {
    expect(() =>
      createCompatibilityPmsBookingReservationsReadRepository({ connectionString: " " }),
    ).toThrow("Booking reservations repository connectionString must not be empty");
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
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
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

  it("defaults missing booking guest-form settings fields to the legacy response defaults", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return {
            specialRequestsEnabled: null,
            arrivalTimeEnabled: null,
            guestCountEnabled: null,
          };
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      specialRequestsEnabled: true,
      arrivalTimeEnabled: false,
      guestCountEnabled: false,
    });
  });

  it("defaults unset booking benefits to the legacy empty list", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return { benefits: null };
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: [],
    });
  });

  it("defaults malformed and non-list booking benefits values to the legacy empty list", async () => {
    const malformedValues: unknown[] = ['{"not": "a list"}', "not json", 42, { nested: true }];

    for (const benefits of malformedValues) {
      const malformedApp = buildAuthenticatedApp({
        settingsRepository: {
          async findAddonSettingsByHotelId() {
            return null;
          },
          async findGuestFormSettingsByHotelId() {
            return null;
          },
          async findBenefitsSettingsByHotelId() {
            return { benefits };
          },
          async findLocalizationSettingsByHotelId() {
            return null;
          },
        },
      });

      const response = await injectJson(malformedApp, {
        method: "GET",
        url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        benefits: [],
      });

      await malformedApp.close();
    }
  });

  it("drops non-string booking benefits entries instead of failing the read", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return { benefits: ["Free breakfast", 42, null, { label: "Spa" }, "Late checkout"] };
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: ["Free breakfast", "Late checkout"],
    });
  });

  it("parses JSON-encoded booking benefits strings like the legacy read path", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return { benefits: '["Free parking", "Welcome drink"]' };
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: ["Free parking", "Welcome drink"],
    });
  });

  it("defaults missing booking localization settings fields to the contract defaults", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return {
            defaultCurrency: null,
            defaultLanguage: null,
            supportedCurrencies: null,
            supportedLanguages: null,
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      defaultCurrency: "EUR",
      defaultLanguage: "en",
      supportedCurrencies: [],
      supportedLanguages: ["en"],
    });
  });

  it("defaults malformed booking localization lists to the contract defaults", async () => {
    const malformedValues: unknown[] = ['{"not": "a list"}', "not json", 42, { nested: true }];

    for (const malformedValue of malformedValues) {
      const malformedApp = buildAuthenticatedApp({
        settingsRepository: {
          async findAddonSettingsByHotelId() {
            return null;
          },
          async findGuestFormSettingsByHotelId() {
            return null;
          },
          async findBenefitsSettingsByHotelId() {
            return null;
          },
          async findLocalizationSettingsByHotelId() {
            return {
              defaultCurrency: "EUR",
              defaultLanguage: "en",
              supportedCurrencies: malformedValue,
              supportedLanguages: malformedValue,
            };
          },
        },
      });

      const response = await injectJson(malformedApp, {
        method: "GET",
        url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        defaultCurrency: "EUR",
        defaultLanguage: "en",
        supportedCurrencies: [],
        supportedLanguages: ["en"],
      });

      await malformedApp.close();
    }
  });

  it("parses JSON-encoded booking localization lists like the legacy read path", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return {
            defaultCurrency: "EUR",
            defaultLanguage: "en",
            supportedCurrencies: '["EUR", "USD"]',
            supportedLanguages: '["en", "de"]',
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      defaultCurrency: "EUR",
      defaultLanguage: "en",
      supportedCurrencies: ["EUR", "USD"],
      supportedLanguages: ["en", "de"],
    });
  });

  it("defaults missing booking room-filter settings fields to the contract defaults", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
        async findRoomFilterSettingsByHotelId() {
          return {
            bookingFilters: null,
            customFilters: null,
            filterRooms: null,
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: [],
      customFilters: {},
      filterRooms: {},
    });
  });

  it("returns empty room-filter settings when the authorized hotel has no settings row", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: [],
      customFilters: {},
      filterRooms: {},
    });
  });

  it("hardens malformed booking room-filter values to contract defaults", async () => {
    const malformedValues: unknown[] = ["not json", 42, null, ["not", 1]];

    for (const malformedValue of malformedValues) {
      const malformedApp = buildAuthenticatedApp({
        settingsRepository: {
          async findAddonSettingsByHotelId() {
            return null;
          },
          async findGuestFormSettingsByHotelId() {
            return null;
          },
          async findBenefitsSettingsByHotelId() {
            return null;
          },
          async findLocalizationSettingsByHotelId() {
            return null;
          },
          async findRoomFilterSettingsByHotelId() {
            return {
              bookingFilters: malformedValue,
              customFilters: malformedValue,
              filterRooms: malformedValue,
            };
          },
        },
      });

      const response = await injectJson(malformedApp, {
        method: "GET",
        url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        bookingFilters:
          typeof malformedValue === "object" && Array.isArray(malformedValue) ? ["not"] : [],
        customFilters: {},
        filterRooms: {},
      });

      await malformedApp.close();
    }
  });

  it("drops invalid room-filter entries instead of failing the read", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
        async findRoomFilterSettingsByHotelId() {
          return {
            bookingFilters: ["oceanView", 42, null, "suite"],
            customFilters: {
              oceanView: "Ocean view",
              bad: 42,
            },
            filterRooms: {
              oceanView: ["room_101", null, 123, "room_102"],
              broken: "room_999",
            },
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: ["oceanView", "suite"],
      customFilters: {
        oceanView: "Ocean view",
      },
      filterRooms: {
        oceanView: ["room_101", "room_102"],
        broken: [],
      },
    });
  });

  it("parses JSON-encoded booking room-filter values like the legacy read path", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
        async findRoomFilterSettingsByHotelId() {
          return {
            bookingFilters: '["oceanView", "spa_access"]',
            customFilters: '{"spa_access": "Spa access"}',
            filterRooms: '{"oceanView": ["room_101"], "spa_access": ["room_102"]}',
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: ["oceanView", "spa_access"],
      customFilters: {
        spa_access: "Spa access",
      },
      filterRooms: {
        oceanView: ["room_101"],
        spa_access: ["room_102"],
      },
    });
  });

  it("rejects booking addon settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
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
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
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
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
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
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
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
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
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
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("rejects booking guest-form settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking guest-form settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking guest-form settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking guest-form settings when entitlement is suspended", async () => {
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
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking guest-form settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("rejects booking benefits settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking benefits settings with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking benefits settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking benefits settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking benefits settings when entitlement is suspended", async () => {
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
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking benefits settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("rejects booking localization settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking localization settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking localization settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking localization settings when entitlement is suspended", async () => {
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
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking localization settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("rejects booking room-filter settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking room-filter settings with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking room-filter settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking room-filter settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking room-filter settings when entitlement is suspended", async () => {
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
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking room-filter settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("returns the booking addon settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
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

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking add-on settings are unavailable.",
    });
  });

  it("returns the booking guest-form settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking guest-form settings are unavailable.",
    });
  });

  it("returns the booking benefits settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking benefits settings are unavailable.",
    });
  });

  it("returns the booking localization settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          throw new Error("database unavailable");
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking localization settings are unavailable.",
    });
  });

  it("returns the booking room-filter settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
        async findRoomFilterSettingsByHotelId() {
          throw new Error("database unavailable");
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking room-filter settings are unavailable.",
    });
  });

  it("rejects booking reservations without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
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
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
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
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking reservation permission.",
    });
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
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
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
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
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
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
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
    expect(response.body).toEqual({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      message: "Booking hotel addon settings not found.",
    });
  });

  it("returns 404 when the authorized booking hotel has no guest-form settings record", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      message: "Booking hotel guest-form settings not found.",
    });
  });

  it("returns the legacy empty benefits list when the authorized booking hotel has no benefits record", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: [],
    });
  });

  it("returns 404 when the authorized booking hotel has no localization settings record", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      message: "Booking hotel localization settings not found.",
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
