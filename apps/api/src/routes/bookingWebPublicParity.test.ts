import { externalBookingChanges } from "../integrations/externalBookingChanges.js";
import {
  buildPublicBookabilityQuoteProjection,
  findForbiddenPublicBookabilityKeys,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityAvailabilityOfferInput,
  type PublicBookabilityHotelProfile,
  type PublicBookabilityQuoteProjection,
} from "@vayada/domain-distribution";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION } from "@vayada/domain-booking";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import type { PublicHotelQuoteQuery, PublicHotelQuoteRepository } from "./aiHotelQuotes.js";
import {
  toPublicHotelProfileProjection,
  type BookingHotelProfileRow,
  type PublicHotelProfileRepository,
} from "./aiHotels.js";
import {
  createTargetBookingWebCheckoutAdapter,
  recordTargetCheckoutCommand,
  resolveTargetCheckoutAmountSnapshot,
  targetCardPaymentIdempotencyKey,
  type BookingWebCalendarProjection,
  type BookingWebCalendarRepository,
  type BookingWebCalendarReadPool,
  type BookingWebCheckoutAdapter,
} from "./bookingWebPublic.js";
import { unusedBookingWebCheckoutAdapter } from "./bookingWebPublic.fixtures.js";

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
    legacyField: "HotelResponse.contact/socialLinks",
    targetField: "omitted",
    reason:
      "These fields are not required by the read-only bootstrap adapters and remain outside this public-safe parity slice.",
  },
] as const;

it("namespaces Stripe idempotency by property without exposing the public key", () => {
  const publicKey = "guest-controlled-retry-key";
  const first = targetCardPaymentIdempotencyKey("a9fccec2-eb4c-4c35-bfd3-02a748c2e117", publicKey);
  const second = targetCardPaymentIdempotencyKey("b9fccec2-eb4c-4c35-bfd3-02a748c2e952", publicKey);

  expect(first).not.toBe(second);
  expect(first).not.toContain(publicKey);
  expect(second).not.toContain(publicKey);
});

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
      nonrefundable: ["card", "bank_transfer"],
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

describe("Booking Web public bootstrap parity", () => {
  it("fails clearly when the non-checkout fixture reaches checkout", () => {
    const checkoutAdapter: BookingWebCheckoutAdapter = unusedBookingWebCheckoutAdapter;
    expect(() => checkoutAdapter.getCheckoutConfig("hotel-alpenrose")).toThrow(
      "Unexpected Booking Web checkout adapter call: getCheckoutConfig",
    );
    expect(checkoutAdapter.close).toBeUndefined();
  });

  it("records booking-web telemetry through the configured sink without legacy forwarding", async () => {
    const events: unknown[] = [];
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
      bookingWebPublicNow: () => new Date("2026-06-06T11:00:00.000Z"),
      bookingWebAttributionSink: {
        async recordTelemetryEvent(event) {
          events.push(event);
        },
      },
    });

    for (const consent of [
      {},
      { analyticsConsent: false, consentVersion: BOOKING_WEB_ANALYTICS_CONSENT_VERSION },
      { analyticsConsent: "true", consentVersion: BOOKING_WEB_ANALYTICS_CONSENT_VERSION },
      // A choice under the earlier consent text (VAY-2213 asks everyone again) or a future one.
      { analyticsConsent: true, consentVersion: 1 },
      { analyticsConsent: true, consentVersion: BOOKING_WEB_ANALYTICS_CONSENT_VERSION + 1 },
    ]) {
      const denied = await app.inject({
        method: "POST",
        url: "/api/booking-web/events",
        payload: { hotelSlug: "unknown-hotel", eventType: "page_visit", ...consent },
      });
      expect(denied.statusCode).toBe(204);
      expect(events).toEqual([]);
    }

    // VAY-2197: funnel events only, with each type's allowlisted properties and random ids.
    const sessionId = "0b6f0f6e-6a1b-4c39-9d1e-5d3c2a1b0f9e";
    const event = (eventType: string, metadata: unknown, ids = {}) =>
      app.inject({
        method: "POST",
        url: "/api/booking-web/events",
        payload: {
          analyticsConsent: true,
          consentVersion: BOOKING_WEB_ANALYTICS_CONSENT_VERSION,
          hotelSlug: "hotel-alpenrose",
          eventType,
          eventId: randomUUID(),
          sessionId,
          metadata,
          ...ids,
        },
      });
    const response = await event("page_visit", { funnelVersion: 1, funnelSequence: 1 });

    for (const [eventType, metadata, ids] of [
      ["page_visit", { funnelVersion: 1, funnelSequence: 0 }],
      ["page_visit", { locale: "de" }],
      ["page_visit", { funnelVersion: 1, funnelSequence: 2, email: "guest@example.com" }],
      [
        "complete_booking_clicked",
        { funnelVersion: 1, funnelSequence: 2, paymentMethod: "unknown", mode: "instant" },
      ],
      ["searched_dates", { funnelVersion: 1, funnelSequence: 2 }],
      ["page_visit", { funnelVersion: 1, funnelSequence: 2 }, { sessionId: "sid_123" }],
      ["page_visit", { funnelVersion: 1, funnelSequence: 2 }, { eventId: undefined }],
    ] as const) {
      const invalid = await event(eventType, metadata, ids);
      expect(invalid.statusCode).toBe(400);
    }
    const oversized = await event("page_visit", {
      funnelVersion: 1,
      funnelSequence: 2,
      pad: "x".repeat(4096),
    });
    expect(oversized.statusCode).toBe(413);
    // Room-detail views, step views and errors are accepted although none is a stage.
    const roomViewed = await event("room_viewed", {
      funnelVersion: 1,
      funnelSequence: 2,
      roomTypeId: "suite",
    });
    const stepViewed = await event("step_viewed", {
      funnelVersion: 1,
      funnelSequence: 3,
      step: "extras",
    });
    const failed = await event("booking_error", {
      funnelVersion: 1,
      funnelSequence: 4,
      step: "payment",
      reason: "booking_unavailable",
      code: "CARD_PAYMENT_UNAVAILABLE",
    });
    expect([response, roomViewed, stepViewed, failed].map((r) => r.statusCode)).toEqual([
      204, 204, 204, 204,
    ]);
    expect(events).toMatchObject([
      {
        propertyId: "booking_hotel_alpenrose",
        hotelSlug: "hotel-alpenrose",
        eventType: "page_visit",
        sessionId,
        metadata: { funnelVersion: 1, funnelSequence: 1 },
      },
      { eventType: "room_viewed", sessionId, metadata: { roomTypeId: "suite" } },
      { eventType: "step_viewed", metadata: { step: "extras" } },
      { eventType: "booking_error", metadata: { code: "CARD_PAYMENT_UNAVAILABLE" } },
    ]);
    for (const recorded of events) {
      expect(recorded).not.toHaveProperty("ipAddress");
      expect(recorded).not.toHaveProperty("requestId");
    }
    await app.close();
  });

  it("writes no access log line for funnel events (VAY-2197)", async () => {
    let logs = "";
    const app = buildApp({
      logger: { level: "info", stream: { write: (chunk: string) => (logs += chunk) } },
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
      bookingWebAttributionSink: {
        async recordTelemetryEvent() {},
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/events",
      remoteAddress: "203.0.113.7",
      payload: {
        analyticsConsent: true,
        consentVersion: BOOKING_WEB_ANALYTICS_CONSENT_VERSION,
        hotelSlug: "hotel-alpenrose",
        eventType: "page_visit",
        eventId: randomUUID(),
        sessionId: randomUUID(),
        metadata: { funnelVersion: 1, funnelSequence: 1 },
      },
    });
    expect(response.statusCode).toBe(204);
    expect(logs).not.toContain("203.0.113.7");
    expect(logs).not.toContain("/api/booking-web/events");
    await app.close();
  });

  describe("funnel event rate limit (VAY-2214)", () => {
    const funnelEvent = (sessionId = randomUUID()) => ({
      analyticsConsent: true,
      consentVersion: BOOKING_WEB_ANALYTICS_CONSENT_VERSION,
      hotelSlug: "hotel-alpenrose",
      eventType: "page_visit",
      eventId: randomUUID(),
      sessionId,
      metadata: { funnelVersion: 1, funnelSequence: 1 },
    });
    const limitedApp = (events: unknown[], logs?: { text: string }) =>
      buildApp({
        logger: logs
          ? { level: "info", stream: { write: (chunk: string) => (logs.text += chunk) } }
          : false,
        trustProxy: ["10.0.0.1"],
        publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
        bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
        bookingWebPublicNow: () => new Date("2026-10-15T12:00:00.000Z"),
        bookingWebAttributionSink: {
          async recordTelemetryEvent(event) {
            events.push(event);
          },
        },
      });

    it("refuses the 61st event a minute from one address, whatever the forwarded-for spoof", async () => {
      const events: unknown[] = [];
      const app = limitedApp(events);
      // Behind the trusted proxy the client is the last untrusted hop; spoofed hops before it
      // don't make a new bucket.
      const viaProxy = (i: number) =>
        app.inject({
          method: "POST",
          url: "/api/booking-web/events",
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": `192.0.2.${i % 250}, 203.0.113.9` },
          payload: funnelEvent(),
        });
      for (let i = 0; i < 60; i += 1) expect((await viaProxy(i)).statusCode).toBe(204);
      const refused = await viaProxy(60);
      expect(refused.statusCode).toBe(429);
      expect(refused.headers["retry-after"]).toBe("60");
      expect(refused.headers["cache-control"]).toBe("no-store");
      expect(events).toHaveLength(60);
      const other = await app.inject({
        method: "POST",
        url: "/api/booking-web/events",
        remoteAddress: "198.51.100.7",
        payload: funnelEvent(),
      });
      expect(other.statusCode).toBe(204);
      await app.close();
    });

    it("refuses the 31st event a minute from one session", async () => {
      const events: unknown[] = [];
      const app = limitedApp(events);
      const sessionId = randomUUID();
      const send = (i: number) =>
        app.inject({
          method: "POST",
          url: "/api/booking-web/events",
          remoteAddress: `198.51.100.${i + 1}`,
          payload: funnelEvent(sessionId),
        });
      for (let i = 0; i < 30; i += 1) expect((await send(i)).statusCode).toBe(204);
      expect((await send(30)).statusCode).toBe(429);
      expect(events).toHaveLength(30);
      await app.close();
    });

    it("logs a refusal once a minute, without the address", async () => {
      const logs = { text: "" };
      const app = limitedApp([], logs);
      for (let i = 0; i < 63; i += 1)
        await app.inject({
          method: "POST",
          url: "/api/booking-web/events",
          remoteAddress: "203.0.113.50",
          payload: funnelEvent(),
        });
      expect(logs.text.match(/funnel events rate limited/g)).toHaveLength(1);
      expect(logs.text).toContain('"limit":"address"');
      expect(logs.text).not.toContain("203.0.113.50");
      await app.close();
    });

    it("accepts a text/plain event from any https booking site, CORS on this route only", async () => {
      const events: unknown[] = [];
      const app = limitedApp(events);
      const origin = "https://www.hotel-example.com";
      const plain = (payload: string, from = origin) =>
        app.inject({
          method: "POST",
          url: "/api/booking-web/events",
          headers: { "content-type": "text/plain;charset=UTF-8", origin: from },
          payload,
        });
      const accepted = await plain(JSON.stringify(funnelEvent()));
      expect(accepted.statusCode).toBe(204);
      expect(accepted.headers["access-control-allow-origin"]).toBe(origin);
      expect(accepted.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(events).toHaveLength(1);
      expect((await plain("not json")).statusCode).toBe(400);
      expect((await plain('["page_visit"]')).statusCode).toBe(400);
      expect((await plain("x".repeat(4096))).statusCode).toBe(413);
      const insecure = await plain(JSON.stringify(funnelEvent()), "http://www.hotel-example.com");
      expect(insecure.headers["access-control-allow-origin"]).toBeUndefined();
      // A preflight from an older JSON client, and the route with a query string, get the same rule.
      const preflightEvents = await app.inject({
        method: "OPTIONS",
        url: "/api/booking-web/events",
        headers: { origin, "access-control-request-method": "POST" },
      });
      expect(preflightEvents.statusCode).toBe(204);
      expect(preflightEvents.headers["access-control-allow-origin"]).toBe(origin);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/booking-web/events?source=test",
            headers: { "content-type": "text/plain", origin },
            payload: JSON.stringify(funnelEvent()),
          })
        ).headers["access-control-allow-origin"],
      ).toBe(origin);
      // Other public routes keep the Vayada booking origins only.
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/api/booking-web/hotels/hotel-alpenrose",
        headers: { origin },
      });
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
      await app.close();
    });
  });

  it("logs no guest address when storing a funnel event fails (VAY-2214)", async () => {
    let logs = "";
    const app = buildApp({
      logger: { level: "info", stream: { write: (chunk: string) => (logs += chunk) } },
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
      bookingWebAttributionSink: {
        async recordTelemetryEvent() {
          throw new Error("storage unavailable");
        },
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/events",
      remoteAddress: "203.0.113.77",
      payload: {
        analyticsConsent: true,
        consentVersion: BOOKING_WEB_ANALYTICS_CONSENT_VERSION,
        hotelSlug: "hotel-alpenrose",
        eventType: "page_visit",
        eventId: randomUUID(),
        sessionId: randomUUID(),
        metadata: { funnelVersion: 1, funnelSequence: 1 },
      },
    });
    expect(response.statusCode).toBe(500);
    expect(logs).not.toContain("203.0.113.77");
    await app.close();
  });

  it("rejects telemetry that cannot be resolved to a canonical property", async () => {
    const events: unknown[] = [];
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
      bookingWebAttributionSink: {
        async recordTelemetryEvent(event) {
          events.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/events",
      payload: {
        analyticsConsent: true,
        consentVersion: BOOKING_WEB_ANALYTICS_CONSENT_VERSION,
        hotelSlug: "unknown-hotel",
        eventType: "page_visit",
        eventId: randomUUID(),
        sessionId: randomUUID(),
        metadata: { funnelVersion: 1, funnelSequence: 1 },
      },
    });

    expect(response.statusCode).toBe(404);
    expect(events).toEqual([]);
    await app.close();
  });

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

  it("passes command context through target checkout adapter paths without legacy URLs", async () => {
    const operations: Array<{
      operation: string | undefined;
      requestId: string | undefined;
      correlationId: string | undefined;
      idempotencyKey: string | undefined;
      fingerprint: string | undefined;
      occurredAt: string | undefined;
    }> = [];
    let closed = 0;
    const record = (context: Parameters<BookingWebCheckoutAdapter["getCheckoutConfig"]>[1]) => {
      operations.push({
        operation: context?.operation,
        requestId: context?.requestId,
        correlationId: context?.correlationId,
        idempotencyKey: context?.idempotencyKey,
        fingerprint: context?.fingerprint,
        occurredAt: context?.occurredAt.toISOString(),
      });
    };
    const checkoutAdapter: BookingWebCheckoutAdapter = {
      async getCheckoutConfig(_slug, context) {
        record(context);
        return { payAtPropertyEnabled: true, bankTransfer: true, paypalEnabled: false };
      },
      async quoteBooking(_slug, _request, context) {
        record(context);
        return {
          roomTypeId: "room_deluxe",
          paymentMethod: "pay_at_property",
          totalAmount: 562.5,
          currency: "EUR",
        };
      },
      async createBooking(_slug, _request, context) {
        record(context);
        return {
          bookingReference: "VAY-TARGET-1",
          booking: { bookingReference: "VAY-TARGET-1", status: "confirmed" },
          paymentInstructions: { bankTransfer: { enabled: true, details: null } },
        };
      },
      async confirmAuthorization(_slug, _handle, context) {
        record(context);
        return { bookingReference: "VAY-TARGET-1", status: "confirmed" };
      },
      async getStatus(_slug, _query, context) {
        record(context);
        return { status: "confirmed", paymentStatus: "paid" };
      },
      async lookup(_slug, _request, context) {
        record(context);
        return { bookingReference: "VAY-TARGET-1" };
      },
      async withdraw(_slug, _bookingId, _request, context) {
        record(context);
        return { status: "withdrawn" };
      },
      async cancelPreview(_slug, _bookingId, _request, context) {
        record(context);
        return { refundAmount: 100, refundPercentage: 100, currency: "CHF" };
      },
      async cancel(_slug, _bookingId, _request, context) {
        record(context);
        return { status: "cancelled" };
      },
      async previewChangeRequest(_slug, _bookingId, _request, context) {
        record(context);
        return { oldTotal: 100, newTotal: 100, priceDifference: 0, available: true };
      },
      async submitChangeRequest(_slug, _bookingId, _request, context) {
        record(context);
        return { status: "pending", priceDifference: 0 };
      },
      async getChangeRequest(_slug, _bookingId, _query, context) {
        record(context);
        return { status: "pending" };
      },
      async getPaymentInstructions(_slug, _handle, context) {
        record(context);
        return {
          bankTransfer: { enabled: true, details: null },
          paypal: { enabled: false, email: null, paymentWindowHours: null },
        };
      },
      async validatePromo(_slug, _request, context) {
        record(context);
        return { valid: false, code: "SUMMER10" };
      },
      async close() {
        closed += 1;
      },
    };
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: checkoutAdapter,
      bookingWebPublicNow: () => new Date("2026-06-06T11:00:00.000Z"),
    });

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/booking-web/hotels/hotel-alpenrose/checkout-config" }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings",
        headers: { "Idempotency-Key": "guest-create-1", "X-Correlation-Id": "corr-create-1" },
        payload: { guestEmail: "guest@example.com", checkIn: "2026-09-12", checkOut: "2026-09-15" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/quote",
        headers: { "Idempotency-Key": "guest-quote-1" },
        payload: { guestEmail: "guest@example.com", checkIn: "2026-09-12", checkOut: "2026-09-15" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/b9fccec2-eb4c-4c35-bfd3-02a748c2e951/confirm-authorization",
      }),
      app.inject({
        method: "GET",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/status?reference=VAY-TARGET-1&email=guest%40example.com",
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
        headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" },
        payload: { bookingReference: "VAY-TARGET-1", guestEmail: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/withdraw",
        payload: { guestEmail: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/withdraw",
        payload: { guest_email: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/cancel-preview",
        payload: { guestEmail: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/cancel",
        payload: { guestEmail: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/change-request/preview",
        payload: changeRequestPayload(),
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/change-request/preview",
        payload: {
          ...changeRequestPayload(),
          guestEmail: undefined,
          guest_email: "guest@example.com",
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/change-request",
        payload: changeRequestPayload(),
      }),
      app.inject({
        method: "GET",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/change-request?email=guest%40example.com",
      }),
      app.inject({
        method: "GET",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/payment-instructions",
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/promo/validate",
        payload: { code: "SUMMER10" },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual(Array(16).fill(200));
    expect(operations.map((entry) => entry.operation)).toEqual(
      expect.arrayContaining([
        "checkout-config",
        "booking-quote",
        "booking-create",
        "booking-confirm-authorization",
        "booking-status",
        "booking-lookup",
        "booking-withdraw",
        "booking-cancel-preview",
        "booking-cancel",
        "booking-change-preview",
        "booking-change-submit",
        "booking-change-get",
        "booking-payment-instructions",
        "promo-validate",
      ]),
    );
    expect(operations).toHaveLength(16);
    expect(operations.find((entry) => entry.operation === "booking-create")?.idempotencyKey).toBe(
      "guest-create-1",
    );
    expect(operations.find((entry) => entry.operation === "booking-create")).toMatchObject({
      correlationId: "corr-create-1",
      occurredAt: "2026-06-06T11:00:00.000Z",
    });
    expect(
      operations.every(
        (entry) =>
          typeof entry.requestId === "string" &&
          typeof entry.correlationId === "string" &&
          /^[a-f0-9]{64}$/.test(entry.fingerprint ?? "") &&
          entry.occurredAt === "2026-06-06T11:00:00.000Z",
      ),
    ).toBe(true);
    expect(operations.every((entry) => entry.idempotencyKey)).toBe(true);
    const withdrawContexts = operations.filter((entry) => entry.operation === "booking-withdraw");
    const changePreviewContexts = operations.filter(
      (entry) => entry.operation === "booking-change-preview",
    );
    expect(withdrawContexts).toHaveLength(2);
    expect(changePreviewContexts).toHaveLength(2);
    expect(new Set(withdrawContexts.map((entry) => entry.fingerprint))).toHaveLength(1);
    expect(new Set(withdrawContexts.map((entry) => entry.idempotencyKey))).toHaveLength(1);
    expect(new Set(changePreviewContexts.map((entry) => entry.fingerprint))).toHaveLength(1);
    expect(new Set(changePreviewContexts.map((entry) => entry.idempotencyKey))).toHaveLength(1);
    await app.close();
    expect(closed).toBe(1);
  });

  it("admits five booking lookups per minute per client address, counted in memory", async () => {
    const lookups: string[] = [];
    const app = buildApp({
      logger: false,
      trustProxy: ["10.0.0.1"],
      bookingWebPublicNow: () => new Date("2026-09-02T10:00:30.000Z"),
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      // The adapter has no lookup-attempt method any more: nothing about the address reaches
      // the database (VAY-2222).
      bookingWebCheckoutAdapter: {
        ...unusedBookingWebCheckoutAdapter,
        async lookup(_slug, request) {
          lookups.push(String(request.bookingReference));
          return {};
        },
      },
    });
    const injectLookup = (remoteAddress: string, forwardedFor: string, reference: string) =>
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
        remoteAddress,
        headers: { "x-forwarded-for": forwardedFor },
        payload: { bookingReference: reference, guestEmail: "guest@example.test" },
      });

    // An untrusted caller can't spread its tries over made-up forwarded addresses.
    for (let attempt = 1; attempt <= 5; attempt += 1)
      expect(
        (await injectLookup("198.51.100.44", `192.0.2.${attempt}`, `VAY-${attempt}`)).statusCode,
      ).toBe(200);
    const limited = await injectLookup("198.51.100.44", "192.0.2.6", "VAY-6");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("30");
    expect(limited.json()).toMatchObject({
      message: "Too many booking lookup attempts. Please try again later.",
    });

    // Behind a trusted proxy each forwarded client has its own bucket, not the proxy's.
    for (let attempt = 7; attempt <= 11; attempt += 1)
      expect(
        (await injectLookup("10.0.0.1", "198.51.100.1, 203.0.113.9", `VAY-${attempt}`)).statusCode,
      ).toBe(200);
    expect((await injectLookup("10.0.0.1", "203.0.113.9", "VAY-12")).statusCode).toBe(429);
    expect((await injectLookup("10.0.0.1", "203.0.113.10", "VAY-13")).statusCode).toBe(200);
    expect(lookups).toEqual(
      [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13].map((attempt) => `VAY-${attempt}`),
    );
    await app.close();
  });

  it("rejects public booking references as authorization handles", async () => {
    let called = false;
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: {
        ...unusedBookingWebCheckoutAdapter,
        async confirmAuthorization() {
          called = true;
          return {};
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-ABC123/confirm-authorization",
    });

    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
    await app.close();
  });

  it("keeps one checkout attempt replayable while distinct attempt tokens create distinct quotes", async () => {
    const keys: string[] = [];
    const checkoutAdapter: BookingWebCheckoutAdapter = {
      ...unusedBookingWebCheckoutAdapter,
      async quoteBooking(_slug, _request, context) {
        if (!context) throw new Error("Missing checkout command context");
        keys.push(context.idempotencyKey);
        return {
          quoteId: context.idempotencyKey === "quote-attempt-a" ? "Q-A" : "Q-B",
          roomTypeId: "room-deluxe",
          paymentMethod: "pay_at_property",
          totalAmount: 100,
          currency: "EUR",
        };
      },
    };
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: checkoutAdapter,
    });
    const request = {
      method: "POST" as const,
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/quote",
      payload: {
        roomTypeId: "room-deluxe",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
      },
    };

    const responses = await Promise.all([
      app.inject({ ...request, headers: { "Idempotency-Key": "quote-attempt-a" } }),
      app.inject({ ...request, headers: { "Idempotency-Key": "quote-attempt-a" } }),
      app.inject({ ...request, headers: { "Idempotency-Key": "quote-attempt-b" } }),
    ]);

    expect(responses.map((response) => [response.statusCode, response.json()])).toEqual([
      [200, expect.objectContaining({ quoteId: "Q-A" })],
      [200, expect.objectContaining({ quoteId: "Q-A" })],
      [200, expect.objectContaining({ quoteId: "Q-B" })],
    ]);
    expect(keys).toEqual(["quote-attempt-a", "quote-attempt-a", "quote-attempt-b"]);
    await app.close();
  });

  it("completes reserved checkout idempotency rows with response fields", async () => {
    const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return { rows: [] };
      },
    } as unknown as BookingWebCalendarReadPool;

    await recordTargetCheckoutCommand(pool, {
      propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
      resourceType: "guest_booking",
      resourceId: "booking_123",
      body: { bookingReference: "VAY-123" },
      context: {
        operation: "booking-create",
        requestId: "req-1",
        correlationId: "corr-1",
        idempotencyKey: "idem-1",
        fingerprint: "f".repeat(64),
        occurredAt: new Date("2026-06-20T21:07:48.453Z"),
      },
    });

    expect(calls[0]?.text).toContain("response_status_code = EXCLUDED.response_status_code");
    expect(calls[0]?.text).toContain(
      "response_resource_product = EXCLUDED.response_resource_product",
    );
    expect(calls[0]?.text).toContain("response_resource_type = EXCLUDED.response_resource_type");
    expect(calls[0]?.text).toContain("response_resource_id = EXCLUDED.response_resource_id");
    expect(calls[0]?.text).toContain("idempotency_metadata = CASE");
    expect(JSON.parse(String(calls[0]?.values?.[10]))).toMatchObject({
      responseBody: { bookingReference: "VAY-123" },
    });
  });

  it("replays an identical completed checkout response without repeating side effects", async () => {
    const replayBody = {
      bookingReference: "B-REPLAY123",
      booking: { bookingReference: "B-REPLAY123", paymentStatus: "unpaid" },
      pmsHandoff: { status: "pending_handoff" },
    };
    const calls: string[] = [];
    const pool = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [
              {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                displayName: "Hotel Alpenrose",
                defaultLocale: "en",
              },
            ],
          };
        }
        if (text.includes("FROM hotel_catalog.properties p")) {
          return { rows: [{ phoneRequired: false, acceptedMethods: ["pay_at_property"] }] };
        }
        if (text.includes("FROM booking.guest_bookings booking")) {
          return {
            rows: [
              {
                guestBookingId: "b9fccec2-eb4c-4c35-bfd3-02a748c2e952",
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                publicReference: "B-PAYPAL-1",
                lifecycleStatus: "pending_payment",
                paymentStatus: "unpaid",
                checkIn: "2026-09-12",
                checkOut: "2026-09-15",
                adults: 2,
                children: 0,
                roomCount: 1,
                currency: "EUR",
                totalAmount: "600.00",
                balanceAmount: "600.00",
                bookingMetadata: { paymentMethod: "paypal" },
                createdAt: "2026-09-01T10:00:00.000Z",
              },
            ],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) return { rows: [] };
        if (text.includes("FROM platform.idempotency_keys")) {
          return {
            rows: [
              {
                requestFingerprintHash: "c".repeat(64),
                status: "completed",
                idempotencyMetadata: { responseBody: replayBody },
              },
            ],
          };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      externalChanges: externalBookingChanges,
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });

    await expect(
      adapter.createBooking(
        "hotel-alpenrose",
        { guestEmail: "guest@example.test" },
        {
          operation: "booking-create",
          requestId: "req-replay",
          correlationId: "corr-replay",
          idempotencyKey: "idem-replay",
          fingerprint: "c".repeat(64),
          occurredAt: new Date("2026-09-01T10:00:00.000Z"),
        },
      ),
    ).resolves.toEqual(replayBody);
    expect(calls.some((text) => text.includes("FROM booking.quote_sessions"))).toBe(false);
    expect(calls.some((text) => text.includes("INSERT INTO booking.guest_bookings"))).toBe(false);
    expect(calls.some((text) => text.includes("INSERT INTO platform.jobs"))).toBe(false);
  });

  it("exposes target checkout phone required settings", async () => {
    const calls: string[] = [];
    let termsText: string | null = "Hotel Alpenrose booking terms.";
    let paypalConfigured = true;
    let paymentsEnabled = true;
    let windows: { method: string; kind: string; amount: number; unit: string }[] = [];
    const pool = {
      async query(text: string) {
        calls.push(text);
        // VAY-2348: the hotel's booking windows per payment method.
        if (text.includes("FROM finance.payment_method_booking_windows")) return { rows: windows };
        // VAY-2145: where and when check-in happens, and the bank-transfer and PayPal terms.
        if (text.includes('AS "checkInTime"'))
          return {
            rows: [
              {
                timeZone: "Europe/Vienna",
                checkInTime: "15:00",
                now: new Date("2026-10-12T10:00:00Z"),
              },
            ],
          };
        if (text.includes("SELECT payments_enabled,accepted_methods,deposit_policy"))
          return {
            rows: [
              {
                payments_enabled: true,
                accepted_methods: ["bank_transfer", "paypal", "pay_at_property"],
                deposit_policy: {
                  paypalEmail: "payments@alpenrose.test",
                  paypalPaymentWindowHours: 48,
                },
              },
            ],
          };
        if (text.includes("SELECT id FROM finance.bank_transfer_destinations"))
          return { rows: [{ id: "destination-1" }] };
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [
              {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                displayName: "Hotel Alpenrose",
                defaultLocale: "en",
              },
            ],
          };
        }
        if (text.includes("FROM hotel_catalog.properties p")) {
          return {
            rows: [
              {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                defaultCurrency: "EUR",
                phoneRequired: false,
                termsText,
                cancellationPolicyText: "Free cancellation until seven days before arrival.",
                paymentsEnabled,
                onlineCardReady: false,
                acceptedMethods: [
                  "card",
                  "xendit",
                  "wallet",
                  "manual_card",
                  "bank_transfer",
                  "paypal",
                  "pay_at_property",
                ].filter((method) => paypalConfigured || method !== "paypal"),
                bankTransferReady: true,
                depositPolicy: {
                  bankTransferInstructions: "Bank: Vayada Bank\nIBAN: DE123",
                  paypalEmail: paypalConfigured ? "payments@alpenrose.test" : "",
                  paypalPaymentWindowHours: 48,
                },
                refundPolicy: {},
              },
            ],
          };
        }
        if (text.includes("FROM booking.guest_bookings b")) {
          return {
            rows: [
              {
                guestBookingId: "booking-paypal-1",
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                publicReference: "B-PAYPAL-1",
                lifecycleStatus: "pending_payment",
                paymentStatus: "unpaid",
                checkIn: "2026-09-12",
                checkOut: "2026-09-15",
                adults: 2,
                children: 0,
                roomCount: 1,
                currency: "EUR",
                totalAmount: "600.00",
                balanceAmount: "600.00",
                bookingMetadata: {
                  paymentMethod: "paypal",
                  paymentInstructions: {
                    paypalEmail: "payments@alpenrose.test",
                    paypalPaymentWindowHours: 48,
                  },
                },
                createdAt: "2026-09-01T10:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      externalChanges: externalBookingChanges,
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });

    await expect(adapter.getCheckoutConfig("hotel-alpenrose")).resolves.toMatchObject({
      phoneRequired: false,
      termsText: "Hotel Alpenrose booking terms.",
      cancellationPolicyText: "Free cancellation until seven days before arrival.",
      paymentsEnabled: true,
      onlineCardPayment: false,
      acceptedPaymentMethods: ["bank_transfer", "paypal", "pay_at_property"],
      bankTransfer: true,
      paypalEnabled: true,
      paypalPaymentWindowHours: 48,
      // The booking page keeps its fixed choice until bank transfer and PayPal acceptance is on.
      bookingPagePaymentMethods: ["card", "pay_at_property"],
    });
    await expect(adapter.getCheckoutConfig("hotel-alpenrose")).resolves.not.toHaveProperty(
      "manualPaymentEarliestArrival",
    );
    await expect(
      createTargetBookingWebCheckoutAdapter({
        externalChanges: externalBookingChanges,
        connectionString: "postgres://unused",
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        pool: pool as never,
        replacementPricingManualPaymentAcceptanceEnabled: true,
        bankTransfers: {} as never,
      }).getCheckoutConfig("hotel-alpenrose"),
    ).resolves.toMatchObject({
      bookingPagePaymentMethods: ["pay_at_property", "bank_transfer", "paypal"],
      // 12:00 in Vienna; check-in at 15:00 on the 14th is 51 h away, enough for both windows.
      manualPaymentEarliestArrival: { bank_transfer: "2026-10-14", paypal: "2026-10-14" },
    });
    // Without the bank-details binding bank transfer can't be accepted, so it isn't offered.
    await expect(
      createTargetBookingWebCheckoutAdapter({
        externalChanges: externalBookingChanges,
        connectionString: "postgres://unused",
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        pool: pool as never,
        replacementPricingManualPaymentAcceptanceEnabled: true,
      }).getCheckoutConfig("hotel-alpenrose"),
    ).resolves.toMatchObject({ bookingPagePaymentMethods: ["pay_at_property", "paypal"] });
    await expect(adapter.getCheckoutConfig("hotel-alpenrose")).resolves.not.toHaveProperty(
      "paymentMethodArrivalWindows",
    );
    // VAY-2348: each window as the arrival dates it allows now (12:00 in Vienna, check-in 15:00):
    // within 48 h ends with the 13th (27 h; the 14th is 51 h), at least 7 days starts on the 19th.
    windows = [
      { method: "pay_at_property", kind: "within", amount: 48, unit: "hours" },
      { method: "bank_transfer", kind: "at_least", amount: 7, unit: "days" },
    ];
    await expect(
      createTargetBookingWebCheckoutAdapter({
        externalChanges: externalBookingChanges,
        connectionString: "postgres://unused",
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        pool: pool as never,
        replacementPricingManualPaymentAcceptanceEnabled: true,
        bankTransfers: {} as never,
      }).getCheckoutConfig("hotel-alpenrose"),
    ).resolves.toMatchObject({
      bookingPagePaymentMethods: ["pay_at_property", "bank_transfer", "paypal"],
      paymentMethodArrivalWindows: {
        pay_at_property: { through: "2026-10-13" },
        bank_transfer: { from: "2026-10-19" },
      },
    });
    windows = [];
    paymentsEnabled = false;
    await expect(adapter.getCheckoutConfig("hotel-alpenrose")).resolves.toMatchObject({
      paymentsEnabled: false,
      onlineCardPayment: false,
    });
    paymentsEnabled = true;
    paypalConfigured = false;
    await expect(
      adapter.getPaymentInstructions("hotel-alpenrose", "B-PAYPAL-1"),
    ).resolves.toMatchObject({
      paypal: {
        enabled: true,
        email: "payments@alpenrose.test",
        paymentWindowHours: 48,
      },
    });
    termsText = null;
    await expect(adapter.getCheckoutConfig("hotel-alpenrose")).resolves.toMatchObject({
      termsText: "",
    });
    expect(calls.find((call) => call.includes("FROM hotel_catalog.properties p"))).toContain(
      "hotel_catalog.property_policy_summaries",
    );
    expect(calls.find((call) => call.includes("FROM hotel_catalog.properties p"))).toContain(
      "finance.online_card_readiness",
    );
    expect(calls.find((call) => call.includes("FROM hotel_catalog.properties p"))).toContain(
      "upper(trim(fs.default_currency)) = upper(trim(bs.default_currency))",
    );
  });

  it("restores authoritative PMS inventory exactly once when a confirmed booking is cancelled", async () => {
    const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
    const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e951";
    const calls: string[] = [];
    let inventoryWriteValues: readonly unknown[] | undefined;
    let addOnEvidenceValues: readonly unknown[] | undefined;
    let lifecycleStatus = "confirmed";
    let policySnapshot: Record<string, unknown> = {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
      freeCancellationDays: 14,
      refund: "none",
      tiers: [{ days: 30, refundPercentage: 50 }],
    };
    const booking = () => ({
      guestBookingId,
      propertyId,
      publicReference: "B-CANCEL951",
      lifecycleStatus,
      paymentStatus: "unpaid",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      roomCount: 1,
      currency: "EUR",
      totalAmount: "300.00",
      balanceAmount: "300.00",
      bookingMetadata: {
        selectedOffer: {
          roomTypeId: "room-from-current-booking",
          publicOfferKey: "room-deluxe:flexible",
          rateType: "flexible",
          rateSummary: { refundable: true },
        },
        policySnapshot,
        inventoryReservation: {
          contractVersion: "pms.inventory-reservation.v1",
          owner: "pms",
          source: "booking_engine",
          quoteSessionId: "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
          propertyId,
          roomTypeId: "room-deluxe",
          publicOfferKey: "room-deluxe:flexible",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          roomCount: 1,
        },
      },
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push(text);
        if (text.includes("UPDATE pms.inventory_days")) inventoryWriteValues = values;
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [{ propertyId, displayName: "Hotel Alpenrose", defaultLocale: "en" }],
          };
        }
        if (text.includes("INSERT INTO pms.inventory_reservation_receipts")) {
          return { rows: [{ receiptId: "699e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "999e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
        }
        if (text.includes("JOIN booking.booking_addon_selections selection")) {
          return {
            rows: [
              {
                selectionId: "c9fccec2-eb4c-4c35-bfd3-02a748c2e951",
                serviceDate: "2026-09-13",
                checkIn: "2026-09-12",
                quantity: 1,
                currency: "EUR",
                totalAmount: "25.00",
                ownershipKind: "property",
                partnerCommissionRate: null,
              },
            ],
          };
        }
        if (text.includes("INSERT INTO booking.addon_revenue_evidence")) {
          addOnEvidenceValues = values;
          return { rows: [] };
        }
        if (text.includes("FROM booking.guest_bookings b")) {
          return { rows: [booking()] };
        }
        if (text.includes("WITH updated AS")) {
          if (lifecycleStatus !== "confirmed") return { rows: [] };
          lifecycleStatus = "canceled";
          return { rows: [booking()] };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      externalChanges: externalBookingChanges,
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });
    const request = { guest_email: "guest@example.test" };
    const context = {
      operation: "booking-cancel",
      requestId: "req-cancel",
      correlationId: "corr-cancel",
      idempotencyKey: "cancel-key",
      fingerprint: "d".repeat(64),
      occurredAt: new Date("2026-09-01T10:00:00.000Z"),
    };

    await expect(
      adapter.cancelPreview("hotel-alpenrose", guestBookingId, request, context),
    ).resolves.toMatchObject({
      amountPaid: 0,
      cancellationFeeAmount: 0,
      refundAmount: 0,
      refundPercentage: 0,
      freeCancellationDays: 7,
      daysUntilCheckIn: 11,
      currency: "EUR",
      policy: {
        type: "free_until_days_before_arrival",
        freeCancellationDeadlineDays: 7,
        afterDeadlinePenalty: "full_booking_amount",
        noShowPenalty: "full_booking_amount",
        freeCancellationDays: 14,
        refund: "none",
        tiers: [{ days: 30, refundPercentage: 50 }],
      },
    });

    policySnapshot = {
      kind: "flexible",
      flexibleCancellationType: "free",
      partialRefundCancelWindowDays: 30,
      partialRefundAmountPercent: 50,
      partialRefundTiers: [],
      tiers: [],
      freeCancellationDays: 7,
    };
    await expect(
      adapter.cancelPreview("hotel-alpenrose", guestBookingId, request, context),
    ).resolves.toMatchObject({ freeCancellationDays: 7, daysUntilCheckIn: 11 });

    policySnapshot = {
      flexibleCancellationType: "free",
      partialRefundTiers: [{ minDaysBeforeCheckIn: 30, refundPercent: 50 }],
      freeCancellationDays: 7,
    };
    await expect(adapter.cancelPreview("hotel-alpenrose", guestBookingId, request)).rejects.toThrow(
      "cannot be verified online",
    );

    policySnapshot = {
      flexibleCancellationType: "free",
      tiers: [{ days: 30, refundPercentage: 50 }],
      freeCancellationDays: 7,
    };
    await expect(adapter.cancelPreview("hotel-alpenrose", guestBookingId, request)).rejects.toThrow(
      "cannot be verified online",
    );

    policySnapshot = {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
      flexibleCancellationType: "partial_refund",
      partialRefundTiers: [{ minDaysBeforeCheckIn: 30, refundPercent: 50 }],
    };
    await expect(adapter.cancelPreview("hotel-alpenrose", guestBookingId, request)).rejects.toThrow(
      "cannot be verified online",
    );

    policySnapshot = {};
    await expect(adapter.cancelPreview("hotel-alpenrose", guestBookingId, request)).rejects.toThrow(
      "free-cancellation period cannot be verified",
    );

    policySnapshot = { refund: "none" };
    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, {
        ...context,
        idempotencyKey: "cancel-key-non-refundable",
        fingerprint: "a".repeat(64),
      }),
    ).rejects.toThrow("non-refundable");

    policySnapshot = {
      type: "unknown",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    };
    await expect(adapter.cancelPreview("hotel-alpenrose", guestBookingId, request)).rejects.toThrow(
      "free-cancellation period cannot be verified",
    );

    policySnapshot = {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
    };
    await expect(adapter.cancelPreview("hotel-alpenrose", guestBookingId, request)).rejects.toThrow(
      "free-cancellation period cannot be verified",
    );

    policySnapshot = {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    };
    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, {
        ...context,
        idempotencyKey: "cancel-key-expired",
        fingerprint: "c".repeat(64),
        occurredAt: new Date("2026-09-06T10:00:00.000Z"),
      }),
    ).rejects.toThrow("free-cancellation period has expired");

    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, context),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, {
        ...context,
        idempotencyKey: "cancel-key-2",
        fingerprint: "e".repeat(64),
      }),
    ).rejects.toThrow("Booking can no longer be changed");

    const inventoryWrites = calls.filter((text) => text.includes("UPDATE pms.inventory_days"));
    expect(inventoryWrites).toHaveLength(1);
    expect(inventoryWrites[0]).toContain("assigned_count - $5::integer");
    expect(inventoryWrites[0]).toContain("UPDATE distribution.public_room_offer_snapshots");
    expect(inventoryWriteValues?.slice(0, 5)).toEqual([
      propertyId,
      "room-deluxe",
      "2026-09-12",
      "2026-09-15",
      1,
    ]);
    expect(calls.some((text) => text.includes("'pms-reservation-handoff'"))).toBe(true);
    expect(calls.filter((text) => text === "COMMIT")).toHaveLength(1);
    expect(calls.filter((text) => text === "ROLLBACK")).toHaveLength(3);
    const promoReversals = calls.filter((text) =>
      text.includes("UPDATE booking.promo_applications"),
    );
    expect(promoReversals).toHaveLength(1);
    expect(promoReversals[0]).toContain("current_uses = GREATEST(promo.current_uses - 1, 0)");
    expect(addOnEvidenceValues?.slice(6, 12)).toEqual([
      null,
      "property",
      null,
      "missing_fulfillment",
      "missing",
      `guest-cancel:${context.fingerprint}:addon:c9fccec2-eb4c-4c35-bfd3-02a748c2e951:v1`,
    ]);
  });

  it("rejects paid inventory-releasing guest mutations until refunds are integrated", async () => {
    const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
    const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e953";
    const calls: string[] = [];
    let lifecycleStatus = "confirmed";
    let paymentStatus = "paid";
    const booking = () => ({
      guestBookingId,
      propertyId,
      publicReference: "B-PAID953",
      lifecycleStatus,
      paymentStatus,
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      roomCount: 1,
      currency: "EUR",
      totalAmount: "300.00",
      balanceAmount: "0.00",
      bookingMetadata: {
        paymentMethod: "card",
        inventoryReservation: {
          contractVersion: "pms.inventory-reservation.v1",
          owner: "pms",
        },
      },
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const pool = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [{ propertyId, displayName: "Hotel Alpenrose", defaultLocale: "en" }],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "999e6c2a-95f8-47f2-8bf1-c2d18e3d7a68" }] };
        }
        if (text.includes("FROM booking.guest_bookings b")) {
          return { rows: [booking()] };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      externalChanges: externalBookingChanges,
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });
    const request = { guest_email: "guest@example.test" };

    await expect(
      adapter.cancelPreview("hotel-alpenrose", guestBookingId, request),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, {
        operation: "booking-cancel",
        requestId: "req-cancel-paid",
        correlationId: "corr-cancel-paid",
        idempotencyKey: "cancel-paid-key",
        fingerprint: "9".repeat(64),
        occurredAt: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    lifecycleStatus = "pending_payment";
    paymentStatus = "partially_paid";
    await expect(
      adapter.withdraw("hotel-alpenrose", guestBookingId, request, {
        operation: "booking-withdraw",
        requestId: "req-withdraw-paid",
        correlationId: "corr-withdraw-paid",
        idempotencyKey: "withdraw-paid-key",
        fingerprint: "8".repeat(64),
        occurredAt: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(calls.some((text) => text.includes("WITH updated AS"))).toBe(false);
    expect(calls.some((text) => text.includes("UPDATE pms.inventory_days"))).toBe(false);
  });

  it("fails closed for a booking without persisted inventory and cancellation policy markers", async () => {
    const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
    const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e952";
    const calls: string[] = [];
    const booking = {
      guestBookingId,
      propertyId,
      publicReference: "B-LEGACY952",
      lifecycleStatus: "confirmed",
      paymentStatus: "unpaid",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      roomCount: 1,
      currency: "EUR",
      totalAmount: "300.00",
      balanceAmount: "300.00",
      bookingMetadata: { selectedOffer: { roomTypeId: "room-deluxe" } },
      createdAt: "2026-09-01T10:00:00.000Z",
    };
    const pool = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [{ propertyId, displayName: "Hotel Alpenrose", defaultLocale: "en" }],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "999e6c2a-95f8-47f2-8bf1-c2d18e3d7a67" }] };
        }
        if (text.includes("FROM booking.guest_bookings b")) {
          return { rows: [booking] };
        }
        if (text.includes("WITH updated AS")) {
          return { rows: [{ ...booking, lifecycleStatus: "canceled" }] };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      externalChanges: externalBookingChanges,
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });

    await expect(
      adapter.cancel(
        "hotel-alpenrose",
        guestBookingId,
        { guest_email: "guest@example.test" },
        {
          operation: "booking-cancel",
          requestId: "req-cancel-legacy",
          correlationId: "corr-cancel-legacy",
          idempotencyKey: "cancel-key-legacy",
          fingerprint: "f".repeat(64),
          occurredAt: new Date("2026-09-01T10:00:00.000Z"),
        },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(calls.some((text) => text.includes("UPDATE pms.inventory_days"))).toBe(false);
    expect(calls.some((text) => text.includes("WITH updated AS"))).toBe(false);
    expect(calls.filter((text) => text === "ROLLBACK")).toHaveLength(1);
  });

  it("requires target checkout creates to snapshot the expected quote total", () => {
    const quote = {
      totalAmount: "561600.00",
      balanceAmount: "280800.00",
    };

    expect(
      resolveTargetCheckoutAmountSnapshot(
        {
          expectedTotalAmount: 561600,
          totalAmount: 561600,
          balanceAmount: 561600,
        },
        quote,
      ),
    ).toEqual({
      totalAmount: "561600.00",
      balanceAmount: "561600.00",
    });

    expect(() =>
      resolveTargetCheckoutAmountSnapshot(
        {
          expectedTotalAmount: 561600,
          balanceAmount: 280800,
        },
        quote,
      ),
    ).toThrow("Booking balance changed");

    expect(() =>
      resolveTargetCheckoutAmountSnapshot(
        {
          expectedTotalAmount: 497250,
          totalAmount: 497250,
        },
        quote,
      ),
    ).toThrow("Booking total changed");

    expect(() =>
      resolveTargetCheckoutAmountSnapshot(
        {
          expectedTotalAmount: 561600,
          balanceAmount: 700000,
        },
        quote,
      ),
    ).toThrow("Booking balance changed");

    expect(() => resolveTargetCheckoutAmountSnapshot({ totalAmount: 561600 })).toThrow(
      "expectedTotalAmount is required",
    );
  });

  afterEach(() => vi.useRealTimers());

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
  slugAliases?: Record<string, LegacyHotelResponse>;
}): ReturnType<typeof buildApp> {
  const profileRepository = createProfileRepository(config.hotel, config.slugAliases ?? {});
  const quoteRepository = createQuoteRepository(profileRepository, config.rooms);
  const calendarRepository = createCalendarRepository(config.unavailableDates);

  return buildApp({
    logger: false,
    publicHotelProfileRepository: profileRepository,
    publicHotelQuoteRepository: quoteRepository,
    bookingWebCalendarRepository: calendarRepository,
    bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    bookingWebPublicNow: () => new Date("2026-06-06T11:00:00.000Z"),
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
    async findProfileByCustomDomain(domain) {
      const customDomain = hotel.customDomainUrl?.replace(/^https:\/\//, "");
      return customDomain === domain
        ? toPublicHotelProfileProjection(toProfileRow(hotel), "2026-06-06T11:00:00.000Z", {
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
  return {
    async findQuoteBySlug(slug, query) {
      const profile = await profileRepository.findProfileBySlug(slug);
      if (!profile) return null;
      return parityQuoteProjection(profile.hotel, rooms, query);
    },
  };
}

function createCalendarRepository(
  unavailableDates: LegacyUnavailableDatesResponse,
): BookingWebCalendarRepository {
  return {
    async findCalendarByHotel(hotel, query): Promise<BookingWebCalendarProjection> {
      return {
        contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
        generatedAt: "2026-06-06T11:00:00.000Z",
        publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
        request: {
          hotelSlug: hotel.slug,
          start: query.start ?? "",
          end: query.end ?? "",
        },
        calendar: {
          unavailableDates: unavailableDates.dates,
          minStayByArrival: unavailableDates.min_stay_by_arrival,
          maxStayByArrival: unavailableDates.max_stay_by_arrival,
        },
        freshness: {
          status: "fresh",
          generatedAt: "2026-06-06T11:00:00.000Z",
          sources: [
            {
              owner: "pms",
              lastUpdatedAt: "2026-06-06T11:00:00.000Z",
              status: "fresh",
            },
            {
              owner: "distribution",
              lastUpdatedAt: "2026-06-06T11:00:00.000Z",
              status: "fresh",
            },
          ],
        },
        dataSources: ["pms", "distribution"],
      };
    },
  };
}

function parityQuoteProjection(
  hotel: PublicBookabilityHotelProfile,
  rooms: LegacyRoomResponse[],
  query: PublicHotelQuoteQuery,
): PublicBookabilityQuoteProjection {
  const generatedAt = "2026-06-06T11:00:00.000Z";
  const request = {
    hotelSlug: hotel.slug,
    checkIn: query.check_in ?? "2026-09-12",
    checkOut: query.check_out ?? "2026-09-15",
    nights: nightsBetween(query.check_in ?? "2026-09-12", query.check_out ?? "2026-09-15"),
    adults: Number(query.adults ?? 2),
    children: Number(query.children ?? 0),
    rooms: Number(query.rooms ?? 1),
    currency: query.currency ?? hotel.defaultCurrency,
    locale: query.locale ?? hotel.defaultLocale,
    promoCode: query.promo_code ?? null,
    referralCode: query.referral_code ?? null,
  };

  return buildPublicBookabilityQuoteProjection(generatedAt, {
    request,
    hotelCatalog: { lastUpdatedAt: generatedAt },
    booking: {
      lastUpdatedAt: generatedAt,
      offerPolicies: rooms.flatMap((room) => [
        {
          roomTypeId: room.id,
          ratePlanId: "flexible",
          cancellation: room.cancellationPolicy,
          deposit: "No deposit required.",
        },
        {
          roomTypeId: room.id,
          ratePlanId: "nonrefundable",
          cancellation: room.nonRefundableCancellationPolicy ?? room.cancellationPolicy,
          deposit: "50% deposit required.",
        },
      ]),
    },
    pms: {
      availabilityReady: true,
      lastUpdatedAt: generatedAt,
      offers: rooms.flatMap((room) => parityOffers(room)),
    },
    finance: {
      lastUpdatedAt: generatedAt,
      publicPaymentOptions: ["card", "pay_at_property", "bank_transfer", "paypal"],
      supportedCurrencies: hotel.supportedCurrencies,
    },
    bookingWeb: {
      offerBookingUrlBase: `${hotel.bookingBaseUrl}/${request.locale}/book`,
    },
    quote: {
      quoteId: "quote_parity_001",
      quoteHash: "sha256:parity",
      expiresAt: "2026-06-06T11:15:00.000Z",
      priceGuarantee: "expires_at",
    },
  });
}

function parityOffers(room: LegacyRoomResponse): PublicBookabilityAvailabilityOfferInput[] {
  const flexibleTotal = sum(room.nightlyRates);
  const nonRefundableTotal = sum(room.nonRefundableNightlyRates ?? []);
  const flexible = {
    offerId: `${room.id}:flexible`,
    roomTypeId: room.id,
    ratePlanId: "flexible",
    name: room.name,
    occupancy: {
      maxAdults: room.maxAdults,
      maxChildren: room.maxChildren,
    },
    availableRooms: room.remainingRooms,
    refundable: true,
    paymentOptions: parityPaymentOptions(room.ratePaymentMethods?.flexible, [
      "card",
      "pay_at_property",
    ]),
    totals: {
      currency: room.currency,
      roomTotal: flexibleTotal,
      taxesAndFees: 0,
      discounts: 0,
      grandTotal: flexibleTotal,
    },
  };

  if (!room.nonRefundableNightlyRates || room.nonRefundableNightlyRates.length === 0) {
    return [flexible];
  }

  return [
    flexible,
    {
      offerId: `${room.id}:nonrefundable`,
      roomTypeId: room.id,
      ratePlanId: "nonrefundable",
      name: room.name,
      occupancy: {
        maxAdults: room.maxAdults,
        maxChildren: room.maxChildren,
      },
      availableRooms: room.remainingRooms,
      refundable: false,
      paymentOptions: parityPaymentOptions(room.ratePaymentMethods?.nonrefundable, ["card"]),
      totals: {
        currency: room.currency,
        roomTotal: nonRefundableTotal,
        taxesAndFees: 0,
        discounts: 0,
        grandTotal: nonRefundableTotal,
      },
    },
  ];
}

function parityPaymentOptions(
  values: string[] | undefined,
  fallback: NonNullable<PublicBookabilityAvailabilityOfferInput["paymentOptions"]>,
): PublicBookabilityAvailabilityOfferInput["paymentOptions"] {
  const allowed = new Set(["card", "pay_at_property", "bank_transfer", "paypal"]);
  const options = (values ?? fallback).filter((value) => allowed.has(value));
  return options as PublicBookabilityAvailabilityOfferInput["paymentOptions"];
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.max(
    0,
    Math.round(
      (Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / 86400000,
    ),
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
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
  const secondOffer = actual.quote?.offers?.[1];
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
    [
      "quote.offers[0].policies.deposit",
      "No deposit required.",
      nested(firstOffer, "policies.deposit"),
    ],
    ["quote.offers[1].ratePlanId", "nonrefundable", secondOffer?.["ratePlanId"]],
    ["quote.offers[1].totals.roomTotal", 594, nested(secondOffer, "totals.roomTotal")],
    ["quote.offers[1].paymentOptions", ["card", "bank_transfer"], secondOffer?.["paymentOptions"]],
    [
      "quote.offers[1].policies.deposit",
      "50% deposit required.",
      nested(secondOffer, "policies.deposit"),
    ],
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
const nights = (...amounts: string[]) =>
  (amounts.length === 1 ? [amounts[0]!, amounts[0]!, amounts[0]!] : amounts).map(
    (grossRoomAmount, day) => ({
      stayDate: `2026-09-${day + 12}`,
      grossRoomAmount,
    }),
  );
