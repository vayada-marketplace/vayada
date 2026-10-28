import { injectJson } from "@vayada/backend-test";
import { buildBookingPublicContent } from "@vayada/domain-distribution/booking-publication";
import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import type { FastifyInstance } from "fastify";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPublicRuntimeRepositories } from "./publicRuntime.js";
import type { PublicHotelProfileReadPool } from "./routes/aiHotels.js";
import { unusedBookingWebCheckoutAdapter } from "./routes/bookingWebPublic.fixtures.js";

const legacyRuntimeEnvKeys = [
  "BOOKING_PUBLIC_API_URL",
  "PMS_API_URL",
  "PMS_PUBLIC_API_URL",
  "MARKETPLACE_DATABASE_URL",
] as const;

const nextApiLegacyFreeEnv: NodeJS.ProcessEnv = {
  API_RUNTIME: "next",
  TARGET_DATABASE_URL: "postgresql://target-db",
  PUBLIC_HOTEL_PROFILE_SOURCE: "active_publication",
  PMS_OPERATIONS_SOURCE: "target",
  FINANCE_SOURCE: "target",
  FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN:
    "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555",
  FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS:
    "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555",
  FINANCE_FOLIO_RECIPIENT_KMS_FINGERPRINT_KEY_ARN:
    "arn:aws:kms:eu-west-1:123456789012:key/66666666-7777-8888-9999-000000000000",
};

const publicBookabilityFixture = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "bookable",
)!;

const publicHotelProfilePool: PublicHotelProfileReadPool = {
  async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
    if (text.includes('AS "promoCodes"')) {
      return {
        rows: [{ promoCodes: false, latitude: null, longitude: null }] as unknown as T[],
      };
    }
    // The custom domain must still be verified for the current property (VAY-2134 shared gate).
    if (!text.includes("distribution.active_public_booking_revision")) {
      expect(text).toContain("hotel_catalog.property_domains");
      expect(text).toContain("verification_status = 'verified'");
      return { rows: [{}] as unknown as T[] };
    }
    expect(text).toContain("distribution.active_public_booking_revision");
    expect(text).toContain("distribution.public_booking_content_revisions");
    expect(text).not.toContain("distribution.public_hotel_bookability_profiles");
    expect(text).not.toContain("booking_hotels");

    const fixtureProfile = structuredClone(publicBookabilityFixture.profile);
    if (text.includes("hotel_catalog.property_domains")) {
      const origin = `https://${String(values?.[0])}`;
      fixtureProfile.hotel.canonicalUrl = `${origin}/en`;
      fixtureProfile.hotel.bookingBaseUrl = origin;
      fixtureProfile.hotel.customDomainUrl = origin;
      fixtureProfile.hotel.trust.domainVerified = true;
    }

    return {
      rows: [
        {
          propertyId: fixtureProfile.hotel.propertyId,
          publicContent: activeContent(fixtureProfile),
        },
      ] as unknown as T[],
    };
  },
  async end() {},
};

describe("next-api legacy-free runtime check", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("boots and serves migrated public route groups with legacy runtime envs absent", async () => {
    for (const key of legacyRuntimeEnvKeys) {
      expect(nextApiLegacyFreeEnv[key], `${key} must stay unset for VAY-882`).toBeUndefined();
    }

    const config = loadConfig(nextApiLegacyFreeEnv);
    expect(config).toMatchObject({
      apiRuntime: "next",
      publicHotelProfileSource: "active_publication",
      pmsOperationsSource: "target",
      financeSource: "target",
    });

    const publicRuntime = createPublicRuntimeRepositories(config, { publicHotelProfilePool });

    app = buildApp({
      logger: false,
      ...publicRuntime,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });
    await app.ready();

    const routes = [
      "/api/ai/hotels/hotel-alpenrose",
      "/api/booking-web/hosts/book.alpenrose.example",
      "/api/booking-web/hotels/hotel-alpenrose",
    ];

    for (const url of routes) {
      const response = await injectJson(app, { method: "GET", url });
      expect(response.statusCode, `${url}: ${JSON.stringify(response.body)}`).toBe(200);
    }
    for (const url of [
      "/api/booking-web/hotels/hotel-alpenrose/calendar?start=2026-09-12&end=2026-09-15",
      "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-09-12&check_out=2026-09-15&adults=2",
      "/api/booking-web/hotels/hotel-alpenrose/offers?check_in=2026-09-12&check_out=2026-09-15&adults=2",
    ]) {
      // The retired availability routes are gone (VAY-2387).
      const response = await injectJson(app, { method: "GET", url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("requires the target database because Marketplace is always enabled", () => {
    expect(() => createPublicRuntimeRepositories(loadConfig({}))).toThrow(
      "TARGET_DATABASE_URL is required for target public runtime repositories",
    );
  });
});

function activeContent(profile: typeof publicBookabilityFixture.profile) {
  const result = buildBookingPublicContent({
    sourceManifestHash: `sha256:${"1".repeat(64)}`,
    readinessHash: `sha256:${"2".repeat(64)}`,
    profile,
    rooms: [
      {
        roomTypeId: "room-1",
        name: "Room",
        description: "A room.",
        category: null,
        occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
        beds: [{ type: "double", quantity: 1 }],
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: null,
        images: [{ url: "https://cdn.example/room.jpg" }],
        amenities: ["wifi"],
        rates: [
          {
            ratePlanId: "rate-1",
            currency: "EUR",
            baseNightlyAmount: "100.00",
            refundable: true,
            paymentTiming: "pay_at_property",
          },
        ],
      },
    ],
    calendar: {
      sourceRevision: "calendar-1",
      materializedRevision: "calendar-1",
      currentLocalDate: "2026-06-06",
      coverageFrom: "2026-06-06",
      coverageThrough: "2027-06-06",
      materializedThrough: "2027-06-06",
      expectedDayCount: 366,
      materializedDayCount: 366,
      gapCount: 0,
      roomTypeIds: ["room-1"],
      observedAt: profile.generatedAt,
    },
    finance: {
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      onlinePayment: true,
      payAtProperty: true,
      readyPaymentMethods: ["card", "pay_at_property"],
    },
  });
  if (!result) throw new Error("Expected valid active-publication fixture");
  return result.publicContent;
}
