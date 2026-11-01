import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import { buildBookingPublicContent } from "@vayada/domain-distribution/booking-publication";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createActiveBookingPublicationProfileRepository } from "./routes/activeBookingPublicationProfile.js";
import type { PublicHotelProfileReadPool } from "./routes/aiHotels.js";

const profile = PUBLIC_BOOKABILITY_FIXTURES.find(({ caseId }) => caseId === "bookable")!.profile;
/** Refer a Guest is retired (VAY-2263): the live read reports it off whatever the publication says. */
const retiredReferral = (value: typeof profile) => ({
  ...value,
  hotel: { ...value.hotel, capabilities: { ...value.hotel.capabilities, referralCodes: false } },
});

describe("active immutable Booking publication profile reads", () => {
  it("does not return old published coordinates when current location is hidden", async () => {
    const repository = createActiveBookingPublicationProfileRepository({
      connectionString: "postgresql://unused",
      pool: pool(async (text) =>
        text.includes('AS "promoCodes"')
          ? [{ domainVerified: true, referralEnabled: true, latitude: null, longitude: null }]
          : [{ propertyId: profile.hotel.propertyId, publicContent: content(profile) }],
      ),
    });
    expect((await repository.findProfileBySlug(profile.hotel.slug))?.hotel.location).toMatchObject({
      latitude: null,
      longitude: null,
    });
  });
  it("serves a bank-transfer or PayPal page only while their acceptance is on (VAY-2139)", async () => {
    const manualProfile = structuredClone(profile);
    manualProfile.hotel.capabilities.onlinePayment = false;
    manualProfile.hotel.capabilities.payAtProperty = false;
    const publicContent = content(manualProfile, {
      rates: [
        {
          ratePlanId: `pricing-offer.v2:${"b".repeat(64)}`,
          currency: "EUR",
          pricing: {
            kind: "quote_required",
            publicationRevision: 7,
            termsRevision: "11111111-1111-4111-8111-111111111111",
          },
          mealPlan: "room_only",
        },
      ],
      finance: { onlinePayment: false, payAtProperty: false, readyPaymentMethods: ["paypal"] },
    });
    let paypalEmail = "pay@hotel.example";
    const read = (
      manualPayments?: boolean,
      manualMethods: readonly ("bank_transfer" | "paypal")[] = ["bank_transfer", "paypal"],
    ) =>
      createActiveBookingPublicationProfileRepository({
        connectionString: "postgresql://unused",
        pool: pool(async (text) =>
          text.includes('AS "promoCodes"')
            ? [{ domainVerified: true, referralEnabled: true, latitude: null, longitude: null }]
            : text.includes("FROM finance.payment_settings settings")
              ? [
                  {
                    accepted_methods: ["paypal"],
                    paypal_email: paypalEmail,
                    bank_destination: false,
                  },
                ]
              : [{ propertyId: manualProfile.hotel.propertyId, publicContent }],
        ),
        manualPayments,
        manualMethods,
      }).findProfileBySlug(manualProfile.hotel.slug);
    await expect(read(true)).resolves.toMatchObject({
      hotel: { propertyId: manualProfile.hotel.propertyId },
    });
    // VAY-2139: with PayPal's own switch off, a PayPal-only page is hidden.
    await expect(read(true, ["bank_transfer"])).resolves.toBeNull();
    // Turning their acceptance off takes the page down again.
    await expect(read()).resolves.toBeNull();
    await expect(read(false)).resolves.toBeNull();
    // Without its PayPal email the hotel can't be paid: the page is hidden until it is back.
    paypalEmail = "";
    await expect(read(true)).resolves.toBeNull();
    paypalEmail = "pay@hotel.example";
    await expect(read(true)).resolves.toMatchObject({
      hotel: { propertyId: manualProfile.hotel.propertyId },
    });
  });
  it("returns only a profile reached through the active revision pointer", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const repository = createActiveBookingPublicationProfileRepository({
      connectionString: "postgresql://unused",
      pool: pool(async (text, values) => {
        calls.push({ text, values });
        if (text.includes('AS "promoCodes"')) {
          return [
            {
              domainVerified: true,
              referralEnabled: true,
              promoCodes: true,
              latitude: profile.hotel.location.latitude,
              longitude: profile.hotel.location.longitude,
            },
          ];
        }
        return [{ propertyId: profile.hotel.propertyId, publicContent: content(profile) }];
      }),
    });

    await expect(
      repository.findProfileBySlug(` ${profile.hotel.slug.toUpperCase()} `),
    ).resolves.toEqual(retiredReferral(profile));
    expect(calls[0]?.text).toContain("distribution.active_public_booking_revision");
    expect(calls[0]?.text).toContain("distribution.public_booking_content_revisions");
    expect(calls[0]?.values).toEqual([profile.hotel.slug]);
    expect(calls[1]?.text).toContain('AS "promoCodes"');
    expect(calls[1]?.values).toEqual([profile.hotel.propertyId]);
  });

  it("fails closed for poisoned or unpublished profile content", async () => {
    const privateProfile = structuredClone(profile);
    privateProfile.hotel.trust.bookabilityStatus = "unavailable";
    privateProfile.hotel.trust.reasonCodes = ["unpublished"];
    const repository = createActiveBookingPublicationProfileRepository({
      connectionString: "postgresql://unused",
      pool: pool(async () => [
        {
          propertyId: profile.hotel.propertyId,
          publicContent: { ...content(profile), profile: privateProfile },
        },
      ]),
    });

    await expect(repository.findProfileBySlug(profile.hotel.slug)).resolves.toBeNull();
    await expect(repository.findProfileBySlug("../private")).resolves.toBeNull();

    privateProfile.hotel.capabilities.instantBook = "true" as unknown as boolean;
    await expect(repository.findProfileBySlug(profile.hotel.slug)).resolves.toBeNull();
  });

  it("normalizes custom domains and gates immutable content on current verified ownership", async () => {
    const calls: unknown[][] = [];
    const domainProfile = structuredClone(profile);
    domainProfile.hotel.canonicalUrl = "https://Book.Example.test:443/en";
    domainProfile.hotel.bookingBaseUrl = "https://Book.Example.test:443/";
    domainProfile.hotel.customDomainUrl = "https://Book.Example.test:443/";
    domainProfile.hotel.trust.domainVerified = true;
    const repository = createActiveBookingPublicationProfileRepository({
      connectionString: "postgresql://unused",
      pool: pool(async (text, values) => {
        calls.push([text, values]);
        if (text.includes('AS "promoCodes"')) {
          return [
            {
              domainVerified: true,
              referralEnabled: true,
              promoCodes: true,
              latitude: profile.hotel.location.latitude,
              longitude: profile.hotel.location.longitude,
            },
          ];
        }
        return [
          { propertyId: domainProfile.hotel.propertyId, publicContent: content(domainProfile) },
        ];
      }),
    });

    await expect(
      repository.findProfileByCustomDomain?.("HTTPS://Book.Example.test/path"),
    ).resolves.toEqual(retiredReferral(domainProfile));
    expect(calls[0]?.[0]).toContain("hotel_catalog.property_domains");
    expect(calls[0]?.[0]).toContain("verification_status = 'verified'");
    expect(calls[0]?.[1]).toEqual(["book.example.test"]);
  });

  it("hides a custom-domain page whose domain is no longer verified (VAY-2134)", async () => {
    const domainProfile = structuredClone(profile);
    domainProfile.hotel.canonicalUrl = "https://book.example.test/en";
    domainProfile.hotel.bookingBaseUrl = "https://book.example.test/";
    domainProfile.hotel.customDomainUrl = "https://book.example.test/";
    domainProfile.hotel.trust.domainVerified = true;
    const repository = createActiveBookingPublicationProfileRepository({
      connectionString: "postgresql://unused",
      pool: pool(async (text) => {
        if (text.includes('AS "promoCodes"'))
          return [{ referralEnabled: false, latitude: null, longitude: null }];
        if (!text.includes("distribution.active_public_booking_revision")) return [];
        return [
          { propertyId: domainProfile.hotel.propertyId, publicContent: content(domainProfile) },
        ];
      }),
    });
    await expect(repository.findProfileBySlug(domainProfile.hotel.slug)).resolves.toBeNull();
  });

  it("fails Refer a Guest closed against the current property entitlement", async () => {
    const staleProfile = structuredClone(profile);
    staleProfile.hotel.capabilities.referralCodes = true;
    staleProfile.hotel.branding = {
      logoUrl: null,
      heroImage: null,
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
      showReferAGuestButton: true,
    };
    const repository = createActiveBookingPublicationProfileRepository({
      connectionString: "postgresql://unused",
      pool: pool(async (text) =>
        text.includes('AS "promoCodes"')
          ? [{ domainVerified: true, referralEnabled: false }]
          : [{ propertyId: staleProfile.hotel.propertyId, publicContent: content(staleProfile) }],
      ),
    });

    const result = await repository.findProfileBySlug(staleProfile.hotel.slug);

    expect(result?.hotel.capabilities.referralCodes).toBe(false);
    expect(result?.hotel.branding?.showReferAGuestButton).toBe(false);
  });

  it("takes promo code availability from the live Promos gate, not the publication (VAY-2200)", async () => {
    const published = structuredClone(profile);
    published.hotel.capabilities.promoCodes = true;
    const read = async (promoCodes: boolean) =>
      createActiveBookingPublicationProfileRepository({
        connectionString: "postgresql://unused",
        pool: pool(async (text) =>
          text.includes('AS "promoCodes"')
            ? [{ domainVerified: true, referralEnabled: true, promoCodes }]
            : [{ propertyId: published.hotel.propertyId, publicContent: content(published) }],
        ),
      }).findProfileBySlug(published.hotel.slug);

    expect((await read(false))?.hotel.capabilities.promoCodes).toBe(false);
    expect((await read(true))?.hotel.capabilities.promoCodes).toBe(true);
  });

  it("takes the Gallery button switch from Booking settings, not the publication (VAY-2447)", async () => {
    const published = structuredClone(profile);
    published.hotel.branding = {
      logoUrl: null,
      heroImage: null,
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
    };
    const read = async (showGalleryButton: boolean | null) =>
      createActiveBookingPublicationProfileRepository({
        connectionString: "postgresql://unused",
        pool: pool(async (text) =>
          text.includes('AS "promoCodes"')
            ? [{ domainVerified: true, promoCodes: false, showGalleryButton }]
            : [{ propertyId: published.hotel.propertyId, publicContent: content(published) }],
        ),
      }).findProfileBySlug(published.hotel.slug);

    expect((await read(false))?.hotel.branding?.showGalleryButton).toBe(false);
    expect((await read(true))?.hotel.branding?.showGalleryButton).toBe(true);
    // No settings row: the button keeps showing, as before the switch existed.
    expect((await read(null))?.hotel.branding?.showGalleryButton).toBe(true);
  });
});

type PublicContentInput = Parameters<typeof buildBookingPublicContent>[0];

function content(
  value: typeof profile,
  payment: {
    rates?: PublicContentInput["rooms"][number]["rates"];
    finance?: Partial<PublicContentInput["finance"]>;
  } = {},
) {
  const result = buildBookingPublicContent({
    sourceManifestHash: `sha256:${"1".repeat(64)}`,
    readinessHash: `sha256:${"2".repeat(64)}`,
    profile: value,
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
        rates: payment.rates ?? [
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
      observedAt: value.generatedAt,
    },
    finance: {
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      onlinePayment: true,
      payAtProperty: true,
      readyPaymentMethods: ["card", "pay_at_property"],
      ...payment.finance,
    },
  });
  if (!result) throw new Error("Expected valid Booking public content fixture");
  return result.publicContent;
}

function pool(
  query: (text: string, values?: readonly unknown[]) => Promise<QueryResultRow[]>,
): PublicHotelProfileReadPool {
  return {
    async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
      return { rows: (await query(text, values)) as T[] };
    },
    async end() {},
  };
}
