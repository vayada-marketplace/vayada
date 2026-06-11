import { findForbiddenPublicBookabilityKeys } from "@vayada/domain-distribution";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import {
  createCompatibilityPublicHotelQuoteRepository,
  type PublicHotelQuoteRepository,
} from "./aiHotelQuotes.js";
import {
  toPublicHotelProfileProjection,
  type BookingHotelProfileRow,
  type PublicHotelProfileRepository,
} from "./aiHotels.js";

type LegacyHotelResponse = {
  id: string;
  name: string;
  slug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  customDomainUrl: string | null;
  description: string;
  location: string;
  country: string;
  currency: string;
  supportedCurrencies: string[];
  heroImage: string;
  images: string[];
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  timezone: string;
  defaultLanguage: string;
  supportedLanguages: string[];
  instantBook: boolean;
};

type LegacyRoomResponse = {
  id: string;
  name: string;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  nightlyRates: number[];
  nonRefundableNightlyRates?: number[];
  currency: string;
  remainingRooms: number;
  flexibleRateEnabled: boolean;
  cancellationPolicy: string;
  nonRefundableCancellationPolicy?: string;
  ratePaymentMethods?: Record<string, string[]>;
  rateDepositSettings?: Record<string, { enabled: boolean; percentage: number | null }>;
};

type LegacyUnavailableDatesResponse = {
  dates: string[];
  min_stay_by_arrival: Record<string, number>;
  max_stay_by_arrival: Record<string, number>;
};

type ParityMismatch = {
  caseId: string;
  field: string;
  expected: unknown;
  actual: unknown;
};

const ACCEPTED_BOOTSTRAP_PARITY_DIFFERENCES = [
  {
    legacyField: "HotelResponse.currency",
    targetField: "hotel.defaultCurrency",
    reason: "Distribution exposes the default checkout currency under the public profile.",
  },
  {
    legacyField: "HotelResponse.supportedLanguages",
    targetField: "hotel.supportedLocales",
    reason: "The target contract uses locale terminology consistently across profile and quote.",
  },
  {
    legacyField: "RoomTypeResponse[]",
    targetField: "quote.offers[]",
    reason:
      "Offers are checkout-ready room/rate choices; room marketing fields stay outside the offers route.",
  },
  {
    legacyField: "UnavailableDatesResponse.dates",
    targetField: "calendar.unavailableDates",
    reason: "Calendar fields are camel-cased and grouped under the target calendar projection.",
  },
  {
    legacyField: "HotelResponse.contact/socialLinks/branding",
    targetField: "omitted",
    reason:
      "These fields are not required by the read-only bootstrap adapters and remain outside this public-safe parity slice.",
  },
] as const;

const legacyHotel: LegacyHotelResponse = {
  id: "booking_hotel_alpenrose",
  name: "Hotel Alpenrose",
  slug: "hotel-alpenrose",
  canonicalUrl: "https://hotel-alpenrose.booking.localhost/de",
  bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
  customDomainUrl: null,
  description: "Independent alpine hotel near the old town.",
  location: "Innsbruck",
  country: "AT",
  currency: "CHF",
  supportedCurrencies: ["CHF", "EUR"],
  heroImage: "https://cdn.vayada.example/hotels/alpenrose/front.jpg",
  images: ["https://cdn.vayada.example/hotels/alpenrose/room.jpg"],
  amenities: ["wifi", "breakfast", "parking"],
  checkInTime: "15:00",
  checkOutTime: "11:00",
  timezone: "Europe/Vienna",
  defaultLanguage: "de",
  supportedLanguages: ["de", "en"],
  instantBook: true,
};

const legacyCustomDomainHotel: LegacyHotelResponse = {
  ...legacyHotel,
  canonicalUrl: "https://book.alpenrose.example/de",
  bookingBaseUrl: "https://book.alpenrose.example",
  customDomainUrl: "https://book.alpenrose.example",
};

const legacyRenamedHotel: LegacyHotelResponse = {
  ...legacyHotel,
  name: "Alpenrose Resort",
  slug: "alpenrose-resort",
  canonicalUrl: "https://alpenrose-resort.booking.localhost/de",
  bookingBaseUrl: "https://alpenrose-resort.booking.localhost",
};

const legacyRooms: LegacyRoomResponse[] = [
  {
    id: "room_deluxe",
    name: "Deluxe Double Room",
    maxOccupancy: 3,
    maxAdults: 2,
    maxChildren: 1,
    nightlyRates: [210, 220, 230],
    nonRefundableNightlyRates: [189, 198, 207],
    currency: "CHF",
    remainingRooms: 2,
    flexibleRateEnabled: true,
    cancellationPolicy: "Free cancellation until 7 days before arrival.",
    nonRefundableCancellationPolicy: "Non-refundable from booking",
    ratePaymentMethods: {
      flexible: ["card", "pay_at_property"],
      nonrefundable: ["xendit", "bank_transfer"],
    },
    rateDepositSettings: {
      flexible: { enabled: false, percentage: null },
      nonrefundable: { enabled: true, percentage: 50 },
    },
  },
];

const legacyUnavailableDates: LegacyUnavailableDatesResponse = {
  dates: ["2026-09-14"],
  min_stay_by_arrival: { "2026-09-12": 2 },
  max_stay_by_arrival: { "2026-09-15": 7 },
};

const legacyPaymentSettings = {
  payAtPropertyEnabled: true,
  onlineCardPayment: true,
  bankTransfer: true,
  paypalEnabled: true,
  paypalEmail: "payments@alpenrose.example",
  paypalPaymentWindowHours: 24,
  bankDetails: {
    accountHolder: "Hotel Alpenrose",
    accountType: "iban",
    iban: "AT611904300234573201",
    bankName: "Alpine Bank",
    swift: "ALPEATWW",
  },
  freeCancellationDays: 7,
};

const legacyBooking = {
  id: "booking_internal_1",
  bookingReference: "ALP-1001",
  guestEmail: "guest@example.com",
  status: "confirmed",
  paymentStatus: "paid",
};

describe("Booking Web public bootstrap parity", () => {
  it("preserves hotel page bootstrap fields across the target adapter", async () => {
    const app = buildParityApp({
      hotel: legacyHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(
      compareHotelBootstrapParity("hotel-page-localized-currency", legacyHotel, target),
    ).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("preserves host and custom-domain canonical behavior", async () => {
    const app = buildParityApp({
      hotel: legacyCustomDomainHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
      domainResolutions: {
        "book.alpenrose.example": { slug: "hotel-alpenrose", status: 200 },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hosts/book.alpenrose.example",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(compareHostParity("custom-domain-canonical", legacyCustomDomainHotel, target)).toEqual(
      [],
    );
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("preserves old-host canonical redirects when the projection is already canonical", async () => {
    const app = buildParityApp({
      hotel: legacyRenamedHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
      slugAliases: {
        "hotel-alpenrose": legacyRenamedHotel,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hosts/hotel-alpenrose.booking.localhost",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(compareCanonicalRedirectParity("renamed-property-canonical", target)).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("maps legacy rooms to target offers for localized currency searches", async () => {
    const app = buildParityApp({
      hotel: legacyHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/offers?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&currency=CHF&locale=de",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(compareOffersParity("rooms-offers-localized-currency", legacyRooms, target)).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("maps sold-out or empty legacy room responses to unavailable target offers", async () => {
    const app = buildParityApp({
      hotel: legacyHotel,
      rooms: [],
      unavailableDates: { dates: [], min_stay_by_arrival: {}, max_stay_by_arrival: {} },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/offers?check_in=2026-10-01&check_out=2026-10-02&adults=2&children=0&rooms=1&currency=CHF&locale=de",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(compareSoldOutParity("sold-out-empty-rooms", target)).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("maps legacy unavailable dates to target calendar summaries", async () => {
    const app = buildParityApp({
      hotel: legacyHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/calendar?start=2026-09-12&end=2026-09-20",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(
      compareCalendarParity("calendar-unavailable-dates", legacyUnavailableDates, target),
    ).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("routes checkout lifecycle calls through Booking Web target paths", async () => {
    const legacyCalls: Array<{ method: string; path: string; body: unknown }> = [];
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingPublicApiUrl: "https://api.booking.localhost",
      pmsPublicApiUrl: "https://api.pms.localhost",
      legacyCheckoutCommandProxyEnabled: true,
      async bookingWebPublicFetch(input, init) {
        legacyCalls.push({
          method: init?.method ?? "GET",
          path: `${input.pathname}${input.search}`,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });

        if (input.origin === "https://api.booking.localhost") {
          return jsonResponse({
            valid: true,
            code: input.searchParams.get("code"),
            discountType: "percentage",
            discountValue: 10,
          });
        }
        if (input.pathname.endsWith("/payment-settings")) {
          return jsonResponse(legacyPaymentSettings);
        }
        if (input.pathname.endsWith("/confirm-authorization")) {
          return jsonResponse({ ...legacyBooking, status: "confirmed" });
        }
        if (input.pathname.endsWith("/bookings/status")) {
          return jsonResponse({
            status: "confirmed",
            paymentStatus: "paid",
            hostResponseDeadline: null,
          });
        }
        if (input.pathname.endsWith("/bookings/lookup")) {
          return jsonResponse(legacyBooking);
        }
        if (input.pathname.endsWith("/bookings")) {
          return jsonResponse({
            booking: legacyBooking,
            clientSecret: null,
            xenditInvoiceUrl: null,
            paymentMethod: "pay_at_property",
            bookingReference: "ALP-1001",
            paymentInstructions: {
              bankTransfer: {
                enabled: true,
                details: legacyPaymentSettings.bankDetails,
              },
            },
          });
        }
        return jsonResponse({ detail: "Not found" }, 404);
      },
    });

    const checkoutConfig = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/checkout-config",
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings",
      payload: {
        roomTypeId: "room_deluxe",
        guestEmail: "guest@example.com",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        paymentMethod: "pay_at_property",
      },
    });
    const confirm = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/draft_1/confirm-authorization",
    });
    const status = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/status?reference=ALP-1001&email=guest%40example.com",
    });
    const lookup = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
      payload: { bookingReference: "ALP-1001", guestEmail: "guest@example.com" },
    });
    const paymentInstructions = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/ALP-1001/payment-instructions",
    });
    const promo = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/promo/validate",
      payload: { code: "SUMMER10" },
    });

    expect([
      checkoutConfig.statusCode,
      create.statusCode,
      confirm.statusCode,
      status.statusCode,
      lookup.statusCode,
      promo.statusCode,
    ]).toEqual([200, 200, 200, 200, 200, 200]);
    expect(checkoutConfig.json()).toMatchObject({
      payAtPropertyEnabled: true,
      bankTransfer: true,
      paypalEnabled: true,
    });
    expect(checkoutConfig.json()).not.toHaveProperty("bankDetails");
    expect(checkoutConfig.json()).not.toHaveProperty("paypalEmail");
    expect(create.json()).toMatchObject({ bookingReference: "ALP-1001" });
    expect(confirm.json()).toMatchObject({ bookingReference: "ALP-1001" });
    expect(status.json()).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(lookup.json()).toMatchObject({ bookingReference: "ALP-1001" });
    expect(create.json()).toMatchObject({
      paymentInstructions: {
        bankTransfer: { enabled: true, details: legacyPaymentSettings.bankDetails },
      },
    });
    expect(paymentInstructions.statusCode).toBe(404);
    expect(promo.json()).toMatchObject({ valid: true, code: "SUMMER10" });
    expect(legacyCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/hotels/hotel-alpenrose/payment-settings",
      "POST /api/hotels/hotel-alpenrose/bookings",
      "POST /api/hotels/hotel-alpenrose/bookings/draft_1/confirm-authorization",
      "GET /api/hotels/hotel-alpenrose/bookings/status?reference=ALP-1001&email=guest%40example.com",
      "POST /api/hotels/hotel-alpenrose/bookings/lookup",
      "GET /api/hotels/hotel-alpenrose/validate-promo?code=SUMMER10",
    ]);
    expect(legacyCalls[1]?.body).toMatchObject({ paymentMethod: "pay_at_property" });
    expect(legacyCalls[4]?.body).toEqual({
      bookingReference: "ALP-1001",
      guestEmail: "guest@example.com",
    });
    await app.close();
  });

  it("routes cancel, withdraw, and change-request lifecycle calls through Booking Web target paths", async () => {
    const decisionToken = "must-not-cross-public-boundary";
    const legacyCalls: Array<{ method: string; path: string; body: unknown }> = [];
    const legacyResponses = new Map<string, unknown>([
      [
        "POST /api/hotels/hotel-alpenrose/bookings/booking_refundable/cancel-preview",
        { refundAmount: 660, refundPercentage: 100 },
      ],
      [
        "POST /api/hotels/hotel-alpenrose/bookings/booking_nonrefundable/cancel-preview",
        { refundAmount: 0, refundPercentage: 0 },
      ],
      [
        "POST /api/hotels/hotel-alpenrose/bookings/booking_deposit/cancel-preview",
        {
          refundAmount: 100,
          refundPercentage: 50,
          depositAmount: 200,
          depositRefundAmount: 100,
          freeCancellationDays: 7,
          daysUntilCheckIn: 3,
          currency: "CHF",
        },
      ],
      [
        "POST /api/hotels/hotel-alpenrose/bookings/booking_refundable/cancel",
        { status: "cancelled" },
      ],
      [
        "POST /api/hotels/hotel-alpenrose/bookings/booking_pending/withdraw",
        { status: "withdrawn" },
      ],
      [
        "POST /api/hotels/hotel-alpenrose/bookings/booking_internal_1/change-request/preview",
        {
          oldTotal: 660,
          newTotal: 735,
          priceDifference: 75,
          currency: "CHF",
          blocked: false,
          blockReason: null,
          available: true,
        },
      ],
      [
        "POST /api/hotels/hotel-alpenrose/bookings/booking_internal_1/change-request",
        { status: "pending", priceDifference: 75, decisionToken },
      ],
      [
        "GET /api/hotels/hotel-alpenrose/bookings/booking_change_approved/change-request?email=guest%40example.com",
        { status: "approved", decision_token: decisionToken },
      ],
      [
        "GET /api/hotels/hotel-alpenrose/bookings/booking_change_declined/change-request?email=guest%40example.com",
        {
          status: "declined",
          declineReason: "Requested dates are unavailable",
          decisionToken,
        },
      ],
    ]);
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      pmsPublicApiUrl: "https://api.pms.localhost",
      legacyCheckoutCommandProxyEnabled: true,
      async bookingWebPublicFetch(input, init) {
        legacyCalls.push({
          method: init?.method ?? "GET",
          path: `${input.pathname}${input.search}`,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return jsonResponse(
          legacyResponses.get(`${init?.method ?? "GET"} ${input.pathname}${input.search}`) ?? {
            detail: "Not found",
          },
          legacyResponses.has(`${init?.method ?? "GET"} ${input.pathname}${input.search}`)
            ? 200
            : 404,
        );
      },
    });

    const requests = [
      ["booking_refundable/cancel-preview", { guestEmail: "guest@example.com" }],
      ["booking_nonrefundable/cancel-preview", { guestEmail: "guest@example.com" }],
      ["booking_deposit/cancel-preview", { guestEmail: "guest@example.com" }],
      ["booking_refundable/cancel", { guestEmail: "guest@example.com" }],
      ["booking_pending/withdraw", { guestEmail: "pending@example.com" }],
      ["booking_internal_1/change-request/preview", changeRequestPayload()],
      ["booking_internal_1/change-request", changeRequestPayload()],
    ] as const;
    const responses = await Promise.all(
      requests.map(([path, payload]) =>
        app.inject({
          method: "POST",
          url: `/api/booking-web/hotels/hotel-alpenrose/bookings/${path}`,
          payload,
        }),
      ),
    );
    responses.push(
      await app.inject({
        method: "GET",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/booking_change_approved/change-request?email=guest%40example.com",
      }),
      await app.inject({
        method: "GET",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/booking_change_declined/change-request?email=guest%40example.com",
      }),
    );
    const bodies = responses.map((response) => response.json());

    expect(responses.map((response) => response.statusCode)).toEqual(Array(9).fill(200));
    expect(bodies[0]).toMatchObject({ refundAmount: 660, refundPercentage: 100 });
    expect(bodies[1]).toMatchObject({ refundAmount: 0, refundPercentage: 0 });
    expect(bodies[2]).toMatchObject({
      depositAmount: 200,
      depositRefundAmount: 100,
      refundAmount: 100,
    });
    expect(bodies[3]).toEqual({ status: "cancelled" });
    expect(bodies[4]).toEqual({ status: "withdrawn" });
    expect(bodies[5]).toMatchObject({
      oldTotal: 660,
      newTotal: 735,
      blocked: false,
      available: true,
    });
    expect(bodies[6]).toMatchObject({ status: "pending", priceDifference: 75 });
    expect(bodies[7]).toMatchObject({ status: "approved" });
    expect(bodies[8]).toMatchObject({
      status: "declined",
      declineReason: "Requested dates are unavailable",
    });
    expect(bodies[6]).not.toHaveProperty("decisionToken");
    expect(bodies[7]).not.toHaveProperty("decision_token");
    expect(bodies[8]).not.toHaveProperty("decisionToken");
    expect(legacyCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      ...legacyResponses.keys(),
    ]);
    expect(legacyCalls[0]?.body).toEqual({ guest_email: "guest@example.com" });
    expect(legacyCalls[4]?.body).toEqual({ guest_email: "pending@example.com" });
    expect(legacyCalls[5]?.body).toMatchObject({
      guestEmail: "guest@example.com",
      checkIn: "2026-09-13",
      checkOut: "2026-09-16",
      addonIds: ["addon_breakfast"],
    });
    await app.close();
  });

  it("does not proxy checkout commands to legacy PMS unless explicitly enabled", async () => {
    const legacyCalls: string[] = [];
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingPublicApiUrl: "https://api.booking.localhost",
      pmsPublicApiUrl: "https://api.pms.localhost",
      async bookingWebPublicFetch(input) {
        legacyCalls.push(input.pathname);
        return jsonResponse({});
      },
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings",
      payload: { guestEmail: "guest@example.com" },
    });
    const confirm = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/draft_1/confirm-authorization",
    });
    const withdraw = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/booking_pending/withdraw",
      payload: { guestEmail: "guest@example.com" },
    });
    const cancelPreview = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/booking_1/cancel-preview",
      payload: { guestEmail: "guest@example.com" },
    });
    const changePreview = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/booking_1/change-request/preview",
      payload: changeRequestPayload(),
    });

    expect(create.statusCode).toBe(404);
    expect(confirm.statusCode).toBe(404);
    expect(withdraw.statusCode).toBe(404);
    expect(cancelPreview.statusCode).toBe(404);
    expect(changePreview.statusCode).toBe(404);
    expect(legacyCalls).toEqual([]);
    await app.close();
  });

  it("reports actionable parity mismatches by fixture case and field", () => {
    const mismatches = compareCalendarParity("calendar-unavailable-dates", legacyUnavailableDates, {
      calendar: {
        unavailableDates: [],
        minStayByArrival: {},
        maxStayByArrival: {},
      },
    });

    expect(formatParityMismatches(mismatches)).toContain(
      "calendar-unavailable-dates: calendar.unavailableDates",
    );
  });

  it("documents accepted intentional differences from legacy bootstrap payloads", () => {
    expect(ACCEPTED_BOOTSTRAP_PARITY_DIFFERENCES).toEqual([
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
    ]);
  });
});

function buildParityApp(config: {
  hotel: LegacyHotelResponse;
  rooms: LegacyRoomResponse[];
  unavailableDates: LegacyUnavailableDatesResponse;
  domainResolutions?: Record<string, { slug: string; status: number }>;
  slugAliases?: Record<string, LegacyHotelResponse>;
}): ReturnType<typeof buildApp> {
  const profileRepository = createProfileRepository(config.hotel, config.slugAliases ?? {});
  const quoteRepository = createQuoteRepository(profileRepository, config.rooms);

  return buildApp({
    logger: false,
    publicHotelProfileRepository: profileRepository,
    publicHotelQuoteRepository: quoteRepository,
    bookingPublicApiUrl: "https://api.booking.localhost",
    pmsPublicApiUrl: "https://api.pms.localhost",
    bookingWebPublicNow: () => new Date("2026-06-06T11:00:00.000Z"),
    async bookingWebPublicFetch(input) {
      if (input.origin === "https://api.booking.localhost") {
        const host = input.searchParams.get("domain") ?? "";
        const resolved = config.domainResolutions?.[host];
        return new Response(
          JSON.stringify(resolved ? { slug: resolved.slug } : { detail: "Not found" }),
          {
            status: resolved?.status ?? 404,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (input.pathname.endsWith("/unavailable-dates")) {
        return new Response(JSON.stringify(config.unavailableDates), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify(config.rooms), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function changeRequestPayload(): Record<string, unknown> {
  return {
    guestEmail: "guest@example.com",
    checkIn: "2026-09-13",
    checkOut: "2026-09-16",
    addonIds: ["addon_breakfast"],
    addonQuantities: { addon_breakfast: 2 },
    addonDates: { addon_breakfast: ["2026-09-14"] },
  };
}

function createProfileRepository(
  hotel: LegacyHotelResponse,
  slugAliases: Record<string, LegacyHotelResponse>,
): PublicHotelProfileRepository {
  return {
    async findProfileBySlug(slug) {
      const source = slug === hotel.slug ? hotel : slugAliases[slug];
      return source
        ? toPublicHotelProfileProjection(toProfileRow(source), "2026-06-06T11:00:00.000Z", {
            bookingHostBase: "booking.localhost",
          })
        : null;
    },
  };
}

function createQuoteRepository(
  profileRepository: PublicHotelProfileRepository,
  rooms: LegacyRoomResponse[],
): PublicHotelQuoteRepository {
  return createCompatibilityPublicHotelQuoteRepository({
    profileRepository,
    pmsPublicApiUrl: "https://api.pms.localhost",
    now: () => new Date("2026-06-06T11:00:00.000Z"),
    async fetch(input) {
      expect(input.pathname).toBe("/api/hotels/hotel-alpenrose/rooms");
      return new Response(JSON.stringify(rooms), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

function toProfileRow(hotel: LegacyHotelResponse): BookingHotelProfileRow {
  return {
    id: hotel.id,
    name: hotel.name,
    slug: hotel.slug,
    description: hotel.description,
    location: hotel.location,
    country: hotel.country,
    currency: hotel.currency,
    supported_currencies: hotel.supportedCurrencies,
    hero_image: hotel.heroImage,
    images: hotel.images,
    amenities: hotel.amenities,
    check_in_time: hotel.checkInTime,
    check_out_time: hotel.checkOutTime,
    timezone: hotel.timezone,
    default_language: hotel.defaultLanguage,
    supported_languages: hotel.supportedLanguages,
    custom_domain: hotel.customDomainUrl?.replace(/^https:\/\//, "") ?? null,
    instant_book: hotel.instantBook,
    online_card_payment: true,
    pay_at_property_enabled: true,
    free_cancellation_days: 7,
    terms_text: "Public terms",
    cancellation_policy_text: "Free cancellation until 7 days before arrival.",
    updated_at: "2026-06-06T10:00:00.000Z",
  };
}

function compareHotelBootstrapParity(
  caseId: string,
  legacy: LegacyHotelResponse,
  target: unknown,
): ParityMismatch[] {
  const actual = target as { hotel?: Record<string, unknown> };
  return compareFields(caseId, [
    ["hotel.slug", legacy.slug, actual.hotel?.["slug"]],
    ["hotel.name", legacy.name, actual.hotel?.["name"]],
    ["hotel.canonicalUrl", legacy.canonicalUrl, actual.hotel?.["canonicalUrl"]],
    ["hotel.bookingBaseUrl", legacy.bookingBaseUrl, actual.hotel?.["bookingBaseUrl"]],
    ["hotel.defaultLocale", legacy.defaultLanguage, actual.hotel?.["defaultLocale"]],
    ["hotel.defaultCurrency", legacy.currency, actual.hotel?.["defaultCurrency"]],
    ["hotel.supportedLocales", legacy.supportedLanguages, actual.hotel?.["supportedLocales"]],
    [
      "hotel.supportedCurrencies",
      legacy.supportedCurrencies,
      actual.hotel?.["supportedCurrencies"],
    ],
    [
      "hotel.policies.checkInFrom",
      legacy.checkInTime,
      nested(actual, "hotel.policies.checkInFrom"),
    ],
    [
      "hotel.policies.checkOutUntil",
      legacy.checkOutTime,
      nested(actual, "hotel.policies.checkOutUntil"),
    ],
  ]);
}

function compareHostParity(
  caseId: string,
  legacy: LegacyHotelResponse,
  target: unknown,
): ParityMismatch[] {
  const actual = target as Record<string, unknown>;
  return compareFields(caseId, [
    ["slug", legacy.slug, actual["slug"]],
    ["canonicalUrl", legacy.canonicalUrl, actual["canonicalUrl"]],
    ["bookingBaseUrl", legacy.bookingBaseUrl, actual["bookingBaseUrl"]],
    ["customDomainUrl", legacy.customDomainUrl, actual["customDomainUrl"]],
    ["shouldRedirect", false, actual["shouldRedirect"]],
    ["redirectUrl", null, actual["redirectUrl"]],
  ]);
}

function compareCanonicalRedirectParity(caseId: string, target: unknown): ParityMismatch[] {
  const actual = target as Record<string, unknown>;
  return compareFields(caseId, [
    ["slug", "alpenrose-resort", actual["slug"]],
    ["shouldRedirect", true, actual["shouldRedirect"]],
    ["redirectStatus", 308, actual["redirectStatus"]],
    ["redirectUrl", "https://alpenrose-resort.booking.localhost/de", actual["redirectUrl"]],
  ]);
}

function compareOffersParity(
  caseId: string,
  legacy: LegacyRoomResponse[],
  target: unknown,
): ParityMismatch[] {
  const firstLegacyRoom = legacy[0]!;
  const actual = target as {
    status?: unknown;
    request?: Record<string, unknown>;
    quote?: { offers?: Array<Record<string, unknown>> };
  };
  const firstOffer = actual.quote?.offers?.[0];
  return compareFields(caseId, [
    ["status", "bookable", actual.status],
    ["request.currency", firstLegacyRoom.currency, actual.request?.["currency"]],
    ["request.locale", "de", actual.request?.["locale"]],
    ["quote.offers.length", 2, actual.quote?.offers?.length],
    ["quote.offers[0].roomTypeId", firstLegacyRoom.id, firstOffer?.["roomTypeId"]],
    ["quote.offers[0].name", firstLegacyRoom.name, firstOffer?.["name"]],
    [
      "quote.offers[0].availableRooms",
      firstLegacyRoom.remainingRooms,
      firstOffer?.["availableRooms"],
    ],
    ["quote.offers[0].totals.roomTotal", 660, nested(firstOffer, "totals.roomTotal")],
    ["quote.offers[0].paymentOptions", ["card", "pay_at_property"], firstOffer?.["paymentOptions"]],
  ]);
}

function compareSoldOutParity(caseId: string, target: unknown): ParityMismatch[] {
  const actual = target as {
    status?: unknown;
    unavailableReasons?: Array<Record<string, unknown>>;
    quote?: unknown;
  };
  return compareFields(caseId, [
    ["status", "unavailable", actual.status],
    ["unavailableReasons[0].code", "sold_out", actual.unavailableReasons?.[0]?.["code"]],
    ["quote", undefined, actual.quote],
  ]);
}

function compareCalendarParity(
  caseId: string,
  legacy: LegacyUnavailableDatesResponse,
  target: unknown,
): ParityMismatch[] {
  return compareFields(caseId, [
    ["calendar.unavailableDates", legacy.dates, nested(target, "calendar.unavailableDates")],
    [
      "calendar.minStayByArrival",
      legacy.min_stay_by_arrival,
      nested(target, "calendar.minStayByArrival"),
    ],
    [
      "calendar.maxStayByArrival",
      legacy.max_stay_by_arrival,
      nested(target, "calendar.maxStayByArrival"),
    ],
  ]);
}

function compareFields(
  caseId: string,
  fields: Array<[field: string, expected: unknown, actual: unknown]>,
): ParityMismatch[] {
  return fields
    .filter(([, expected, actual]) => JSON.stringify(expected) !== JSON.stringify(actual))
    .map(([field, expected, actual]) => ({ caseId, field, expected, actual }));
}

function formatParityMismatches(mismatches: ParityMismatch[]): string {
  return mismatches
    .map(
      (mismatch) =>
        `${mismatch.caseId}: ${mismatch.field} expected ${JSON.stringify(
          mismatch.expected,
        )}, received ${JSON.stringify(mismatch.actual)}`,
    )
    .join("\n");
}

function nested(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}
