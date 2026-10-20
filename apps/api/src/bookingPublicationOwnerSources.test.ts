import {
  createBookingDesignReadinessProvider,
  isBookingLaunchOwnerEvidenceValid,
} from "@vayada/domain-booking";
import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
import { describe, expect, it, vi } from "vitest";

import {
  choices,
  now,
  organizationId,
  pricingEvidence,
  propertyId,
} from "./bookingGuestPolicyTestFixtures.js";
import { createBookingBookingPublicationSource } from "./domains/bookingBookingPublicationSource.js";
import { createHotelCatalogBookingPublicationSource } from "./domains/hotelCatalogBookingPublicationSource.js";
import { createPmsBookingPublicationSource } from "./domains/pmsBookingPublicationSource.js";

const mediaObjectId = "a0000000-0000-4000-8000-000000000001";
const roomTypeId = "30000000-0000-4000-8000-000000000003";
const scope = { organizationId, propertyId };
const hash = `sha256:${"a".repeat(64)}` as const;

describe("production Booking publication owner sources", () => {
  it("builds a Catalog snapshot from private canonical rows and exact safe media", async () => {
    const row = {
      propertyId,
      displayName: "Hotel Alpenrose",
      defaultLocale: "en",
      supportedLocales: ["en", "de"],
      profileStatus: "complete",
      lifecycleStatus: "active",
      setupGoLiveContent: true,
      profileRevision: 8,
      sourceUpdatedAt: now,
      timezone: "Europe/Berlin",
      countryCode: "DE",
      region: "Bavaria",
      city: "Alpenstadt",
      latitude: "47.10",
      longitude: "11.20",
      localityPublic: true,
      geoPublic: true,
      mapDisplayMode: "approximate",
      summary: "An alpine retreat.",
      canonicalSlug: "hotel-alpenrose",
      verifiedHostname: null,
      amenities: ["wifi"],
      contacts: [{ type: "email", value: "hello@alpenrose.test" }],
      media: [{ mediaObjectId, mediaType: "hero_image", altText: "Hotel", sortOrder: 0 }],
    };
    const pool = { query: vi.fn(async () => ({ rows: [row] })) };
    const source = createHotelCatalogBookingPublicationSource({
      connectionString: "postgres://unused",
      pool: pool as any,
      mediaResolver: createHotelMediaResolutionPort({
        async loadPublicMedia() {
          return {
            ok: true as const,
            resolvedTarget: { kind: "property" as const, propertyId },
            media: [
              {
                mediaObjectId,
                ownerOrganizationId: organizationId,
                propertyId,
                purpose: "property.hero_image" as const,
                publicVariants: [
                  {
                    variantName: "original_safe" as const,
                    publicUrl: "https://cdn.test/hotel.webp",
                  },
                ],
              },
            ],
          };
        },
      }),
    });
    const evidence = await source.getBookingLaunchEvidence(scope);
    if (evidence.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(evidence.entities[0]?.blockers).toEqual([]);
    expect(evidence.sources.map(({ entityType }) => entityType)).toContain("property_safe_media");

    const request = manifestRequest(evidence.sources);
    await expect(source.getSnapshot(request)).resolves.toMatchObject({
      outcome: "snapshot",
      content: {
        slug: "hotel-alpenrose",
        images: [{ url: "https://cdn.test/hotel.webp", alt: "Hotel" }],
      },
    });
    await expect(
      source.getSnapshot({
        ...request,
        sourceManifest: {
          ...request.sourceManifest,
          sources: request.sourceManifest.sources.map((item, index) =>
            index ? item : { ...item, revision: "wrong" },
          ),
        },
      }),
    ).resolves.toEqual({ outcome: "unavailable", owner: "hotel_catalog" });
    row.lifecycleStatus = "provisioning";
    const provisioning = await source.getBookingLaunchEvidence(scope);
    if (provisioning.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(provisioning.entities[0]?.blockers).toEqual([
      { code: "hotel_setup_in_progress", scope: "launch_configuration", kind: "external_pending" },
    ]);
    // VAY-2247: without a description and an approved image, setup's saves can't make it live.
    row.setupGoLiveContent = false;
    const withoutContent = await source.getBookingLaunchEvidence(scope);
    if (withoutContent.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(withoutContent.entities[0]?.blockers).toEqual([
      { code: "hotel_setup_content_missing", scope: "launch_configuration", kind: "user_fixable" },
    ]);
    row.setupGoLiveContent = true;
    await expect(source.getSnapshot(manifestRequest(provisioning.sources))).resolves.toEqual({
      outcome: "unavailable",
      owner: "hotel_catalog",
    });
    // VAY-2140: an incomplete profile explains itself; setup activates the hotel once complete.
    row.profileStatus = "incomplete";
    const incomplete = await source.getBookingLaunchEvidence(scope);
    if (incomplete.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(incomplete.entities[0]?.blockers.map(({ code }) => code)).toEqual([
      "hotel_profile_incomplete",
    ]);
    // VAY-2288: a city and country kept private ask for the box, not for the data again.
    row.profileStatus = "complete";
    row.lifecycleStatus = "active";
    row.localityPublic = false;
    const hidden = await source.getBookingLaunchEvidence(scope);
    if (hidden.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(hidden.entities[0]?.blockers.map(({ code }) => code)).toEqual([
      "hotel_public_locality_hidden",
    ]);
    row.city = "";
    const missing = await source.getBookingLaunchEvidence(scope);
    if (missing.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(missing.entities[0]?.blockers.map(({ code }) => code)).toEqual([
      "hotel_public_locality_missing",
    ]);
    // VAY-2292: a blank city is missing too; the page trims it to nothing.
    row.city = " ";
    const blank = await source.getBookingLaunchEvidence(scope);
    if (blank.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(blank.entities[0]?.blockers.map(({ code }) => code)).toEqual([
      "hotel_public_locality_missing",
    ]);
    // VAY-2292: an address or time zone the page can't use is a setup item, not a failed publish.
    row.city = "Alpenstadt";
    row.localityPublic = true;
    row.canonicalSlug = "Hotel_Alpenrose";
    row.timezone = "Europe/Atlantis";
    const unusable = await source.getBookingLaunchEvidence(scope);
    if (unusable.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(unusable.entities[0]?.blockers.map(({ code }) => code)).toEqual([
      "hotel_canonical_slug_invalid",
      "hotel_timezone_invalid",
    ]);
  });

  it.each([
    ["media_not_ready", "hotel_public_media_processing", "external_pending"],
    ["media_not_authorized", "hotel_public_media_unavailable", "user_fixable"],
    ["media_not_found", "hotel_public_media_unavailable", "user_fixable"],
  ] as const)("turns %s hotel media into a %s blocker (VAY-2134)", async (code, blocker, kind) => {
    const row = {
      propertyId,
      displayName: "Hotel Alpenrose",
      defaultLocale: "en",
      supportedLocales: ["en"],
      profileStatus: "complete",
      lifecycleStatus: "active",
      profileRevision: 8,
      sourceUpdatedAt: now,
      timezone: "Europe/Berlin",
      countryCode: "DE",
      region: null,
      city: "Alpenstadt",
      latitude: null,
      longitude: null,
      localityPublic: true,
      geoPublic: false,
      mapDisplayMode: "hidden",
      summary: "An alpine retreat.",
      canonicalSlug: "hotel-alpenrose",
      verifiedHostname: null,
      amenities: [],
      contacts: [],
      media: [{ mediaObjectId, mediaType: "logo", altText: null, sortOrder: 0 }],
    };
    const source = createHotelCatalogBookingPublicationSource({
      connectionString: "postgres://unused",
      pool: { query: vi.fn(async () => ({ rows: [row] })) } as any,
      mediaResolver: createHotelMediaResolutionPort({
        async loadPublicMedia() {
          return { ok: false as const, error: { code, mediaObjectIds: [mediaObjectId] } };
        },
      }),
    });

    const evidence = await source.getBookingLaunchEvidence(scope);

    expect(isBookingLaunchOwnerEvidenceValid(evidence, scope, "catalog")).toBe(true);
    if (evidence.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(evidence.entities[0]?.blockers).toEqual([
      { code: blocker, scope: "launch_configuration", kind },
    ]);
    await expect(source.getSnapshot(manifestRequest(evidence.sources))).resolves.toEqual({
      outcome: "unavailable",
      owner: "hotel_catalog",
    });
  });

  it("projects Booking design, guest policy, and settings through Booking-owned ports", async () => {
    const design = designReadiness();
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            acceptanceMode: "instant",
            defaultLanguage: "en",
            supportedLanguages: ["en", "de"],
            headerLogoUrl: "https://cdn.test/logo.webp",
            showContactButton: false,
            showReferAGuestButton: false,
            showLanguageSelector: false,
            showCurrencySelector: true,
            referAGuestModuleEnabled: false,
            heroSubtext: "Book direct.",
            hasActivePromos: true,
            updatedAt: now,
          },
        ],
      })),
    };
    const rules = {
      ...scope,
      sourceRevision: `guest-choices:${propertyId}`,
      confirmedAt: now,
      choices: { ...choices, checkInUntil: "23:00", checkOutFrom: "07:00" },
    };
    const getCurrentGuestRules = vi.fn().mockResolvedValue(rules);
    const source = createBookingBookingPublicationSource({
      connectionString: "postgres://unused",
      pool: pool as any,
      design,
      guestRules: { getCurrentGuestRules },
    });
    const designResult = await design.getBookingDesignReadiness(scope);
    if (designResult.outcome !== "ready") throw new Error(JSON.stringify(designResult));
    const evidence = await source.getBookingLaunchEvidence(scope);
    if (evidence.outcome !== "evidence") throw new Error("Expected Booking evidence");
    expect(isBookingLaunchOwnerEvidenceValid(evidence, scope, "booking")).toBe(true);
    expect(evidence.entities).toHaveLength(2);
    expect(evidence.entities[0]?.bindings?.map(({ expectedSource }) => expectedSource)).toEqual(
      designResult.snapshot.sourceBindings.filter(({ ownerDomain }) => ownerDomain !== "booking"),
    );
    expect(evidence.sources).toContainEqual(designResult.designSource);
    expect(evidence.entities.flatMap(({ blockers }) => blockers)).toEqual([]);

    await expect(source.getSnapshot(manifestRequest(evidence.sources))).resolves.toMatchObject({
      outcome: "snapshot",
      content: {
        branding: {
          logoUrl: "https://cdn.test/logo.webp",
          showContactButton: false,
          showReferAGuestButton: false,
          showLanguageSelector: false,
          showCurrencySelector: true,
          heroImage: "https://cdn.test/cover.webp",
          heroSubtext: "Book direct.",
        },
        policies: {
          checkInFrom: choices.checkInTime,
          checkOutUntil: choices.checkOutTime,
          checkInUntil: "23:00",
          checkOutFrom: "07:00",
        },
        capabilities: { instantBook: true, promoCodes: true, referralCodes: false },
        supportedQuoteParameters: { childrenSupported: true, adultAgeThreshold: 18 },
      },
    });

    expect(evidence.entities[1]?.bindings).toBeUndefined();
    getCurrentGuestRules.mockResolvedValue({
      ...rules,
      sourceRevision: `guest-choices:${organizationId}`,
    });
    await expect(source.getSnapshot(manifestRequest(evidence.sources))).resolves.toEqual({
      outcome: "unavailable",
      owner: "booking",
    });
    getCurrentGuestRules.mockResolvedValue(null);
    expect(await source.getBookingLaunchEvidence(scope)).toMatchObject({
      outcome: "evidence",
      entities: [{}, { blockers: [{ code: "guest_policy_not_configured" }] }],
    });
    for (const invalid of [
      { ...rules, organizationId: propertyId },
      { ...rules, choices: {} },
      { ...rules, sourceRevision: "guest-policy:1" },
      { ...rules, confirmedAt: "invalid" },
    ]) {
      getCurrentGuestRules.mockResolvedValue(invalid);
      expect(await source.getBookingLaunchEvidence(scope)).toMatchObject({
        outcome: "unavailable",
      });
    }
  });

  it("projects exact PMS room, rate, and 366-day calendar evidence", async () => {
    const pricing = pricingEvidence();
    const roomPublication = structuredClone(pricing.roomPublication) as any;
    roomPublication.rooms[0].facts.beds = [{ type: "king", quantity: 1 }];
    roomPublication.rooms[0].media = [
      {
        mediaObjectId,
        altText: "Suite",
        sortOrder: 0,
        publicVariants: [
          { variantName: "original_safe", publicUrl: "https://cdn.test/suite.webp" },
        ],
      },
    ];
    const rate = {
      ratePlanId: `pricing-offer.v2:${"a".repeat(64)}`,
      currency: "EUR",
      pricing: { kind: "quote_required", publicationRevision: 1, termsRevision: propertyId },
      mealPlan: "room_only",
    };
    const offers = {
      scope,
      sourceRevision: `booking.pms.publication.v2:${"b".repeat(64)}`,
      rooms: [{ roomTypeId, offers: [rate] }],
    };
    const getCurrentPricingOffers = vi.fn().mockResolvedValue(offers);
    const diagnoseMissingPricing = vi.fn().mockResolvedValue([]);
    let calendarConfigured = true;
    let inventoryReady = true;
    let inventoryRevision = "calendar:3";
    let inventoryRooms = [roomTypeId];
    let calendarStatus: "current" | "stale" = "current";
    const source = createPmsBookingPublicationSource({
      rooms: {
        async getRoomPublicationSnapshot() {
          return roomPublication;
        },
      },
      pricing: { getCurrentPricingOffers, diagnoseMissingPricing },
      pricingCurrency: {
        async getPropertyPricingCurrency() {
          return {
            contractVersion: "pms-pricing.v1",
            propertyId,
            currency: "EUR",
            pricingCurrencyRevision: 7,
            createdAt: now,
            updatedAt: now,
          } as any;
        },
      },
      operatingCalendar: {
        async getCurrentOperatingCalendarConfiguration() {
          if (!calendarConfigured) return null;
          return {
            sourceStatus: calendarStatus,
            sourceConflicts: [],
            configuration: {
              propertyId,
              source: pmsSource("pms_operating_calendar.v1", propertyId, "calendar:3"),
              sourceInputs: {
                propertyTimeZone: "Europe/Berlin",
                propertyProfile: catalogSource("property_profile", propertyId, "profile:8"),
              },
              updatedAt: now,
            },
          } as any;
        },
        async getOperatingCalendarConfigurationBySource() {
          return null;
        },
      },
      inventory: {
        async getInventoryLaunchReadiness({ requiredCoverage }) {
          return {
            ready: inventoryReady,
            blockers: [],
            requiredCoverage,
            snapshot: {
              configuration: {
                source: pmsSource("pms_operating_calendar.v1", propertyId, inventoryRevision),
              },
              coverage: {
                ...requiredCoverage,
                coverageFrom: requiredCoverage.from,
                coverageThrough: requiredCoverage.through,
                expectedDayCount: 366,
                materializedDayCount: 366,
                gaps: [],
                roomTypeIds: inventoryRooms,
              },
            },
          } as any;
        },
      },
      now: () => new Date(now),
    });
    const evidence = await source.getBookingLaunchEvidence(scope);
    if (evidence.outcome !== "evidence") throw new Error("Expected PMS evidence");
    expect(evidence.entities.flatMap(({ blockers }) => blockers)).toEqual([]);
    await expect(source.getSnapshot(manifestRequest(evidence.sources))).resolves.toMatchObject({
      outcome: "snapshot",
      content: {
        availabilityReady: true,
        rooms: [{ images: [{ url: "https://cdn.test/suite.webp", alt: "Suite" }], rates: [rate] }],
        calendar: { expectedDayCount: 366, materializedDayCount: 366, gapCount: 0 },
      },
    });
    expect(isBookingLaunchOwnerEvidenceValid(evidence, scope, "pms")).toBe(true);
    expect(
      evidence.sources.some((source) => source.entityType === "pms_pricing_publication.v2"),
    ).toBe(true);
    // Finance binds payment methods to this exact source (VAY-2134).
    expect(evidence.sources).toContainEqual({
      ownerDomain: "pms",
      entityType: "pms_property_pricing_currency.v1",
      entityId: propertyId,
      revision: "7",
    });
    const unavailable = () =>
      expect(source.getSnapshot(manifestRequest(evidence.sources))).resolves.toEqual({
        outcome: "unavailable",
        owner: "pms",
      });
    getCurrentPricingOffers.mockResolvedValue(null);
    await unavailable();
    getCurrentPricingOffers.mockResolvedValue({ ...offers, sourceRevision: "changed" });
    await unavailable(); // Previous manifest cannot bind a newer publication.
    getCurrentPricingOffers
      .mockResolvedValue(offers)
      .mockResolvedValueOnce(offers)
      .mockResolvedValueOnce(null);
    await unavailable(); // Revocation while other ports are being read.
    getCurrentPricingOffers
      .mockResolvedValueOnce(offers)
      .mockResolvedValueOnce({ ...offers, sourceRevision: "changed" });
    await unavailable();
    getCurrentPricingOffers.mockResolvedValue({
      ...offers,
      scope: { ...scope, organizationId: propertyId },
    });
    await unavailable();
    getCurrentPricingOffers.mockResolvedValue({ ...offers, rooms: [] });
    await unavailable();
    getCurrentPricingOffers.mockResolvedValue(offers);
    inventoryReady = false;
    await unavailable();
    inventoryReady = true;
    inventoryRevision = "calendar:4";
    await unavailable();
    inventoryRevision = "calendar:3";
    inventoryRooms = [];
    await unavailable();
    inventoryRooms = [roomTypeId];
    roomPublication.blockers.push({
      code: "room_media_missing",
      affectedEntity: { entityType: "property", entityId: propertyId },
    });
    await unavailable();
    roomPublication.blockers = [];
    // VAY-2134: prices the hotel can save again and a calendar it hasn't opened are blockers.
    await expect(source.getBookingLaunchEvidence(scope)).resolves.toMatchObject({
      outcome: "evidence",
    });
    getCurrentPricingOffers.mockResolvedValue(null);
    await expect(source.getBookingLaunchEvidence(scope)).resolves.toEqual({
      outcome: "unavailable",
      port: "pms",
      errorSource: "provider",
      code: "pricing_publication_unavailable",
    });
    diagnoseMissingPricing.mockResolvedValue(["rooms_changed", "payments_changed"]);
    calendarConfigured = false;
    const gaps = await source.getBookingLaunchEvidence(scope);
    expect(isBookingLaunchOwnerEvidenceValid(gaps, scope, "pms")).toBe(true);
    if (gaps.outcome !== "evidence") throw new Error("Expected PMS evidence");
    const blockersOf = (groupId: string) =>
      gaps.entities.filter((item) => item.groupId === groupId).flatMap(({ blockers }) => blockers);
    expect(blockersOf("booking.pricing").map(({ code }) => code)).toEqual([
      "pricing_rooms_changed",
      "pricing_payments_changed",
    ]);
    expect(blockersOf("booking.calendar").map(({ code }) => code)).toEqual([
      "operating_calendar_missing",
    ]);
    expect(blockersOf("booking.rooms")).toEqual([]);
    expect(diagnoseMissingPricing).toHaveBeenCalledWith(propertyId);
    await unavailable();
    diagnoseMissingPricing.mockResolvedValue(["hotel_setup_in_progress"]);
    await expect(source.getBookingLaunchEvidence(scope)).resolves.toMatchObject({
      entities: expect.arrayContaining([
        expect.objectContaining({
          groupId: "booking.pricing",
          blockers: [
            {
              code: "pricing_hotel_setup_in_progress",
              scope: "launch_configuration",
              kind: "external_pending",
            },
          ],
        }),
      ]),
    });
    calendarConfigured = true;
    getCurrentPricingOffers.mockResolvedValue(offers);
    calendarStatus = "stale";
    const staleEvidence = await source.getBookingLaunchEvidence(scope);
    expect(staleEvidence).toMatchObject({
      outcome: "evidence",
      entities: expect.arrayContaining([
        expect.objectContaining({
          groupId: "booking.calendar",
          blockers: [expect.objectContaining({ code: "operating_calendar_source_stale" })],
        }),
      ]),
    });
  });
});

function designReadiness() {
  const source = catalogSource;
  return createBookingDesignReadinessProvider({
    design: {
      async getCurrentDesign() {
        return {
          contractVersion: "booking-design.v1",
          propertyId,
          revision: 4,
          choices: { primaryColor: "#0077B6", fontPairing: "modern-minimalist" },
          createdAt: now,
        } as any;
      },
    },
    profile: {
      bookingDesignCatalogEvidencePort: "profile",
      async getBookingDesignProfileEvidence() {
        return {
          outcome: "evidence",
          evidencePort: "profile",
          ...scope,
          source: source("property_profile", propertyId, "profile:8"),
          profile: {
            contractVersion: "hotel-catalog-step1.v1",
            profileRevision: 8,
            displayName: "Hotel Alpenrose",
            contentLocale: "en",
            shortDescription:
              "A calm alpine hotel with welcoming rooms and a view of the surrounding peaks.",
          },
        } as any;
      },
    },
    coverAssignment: {
      bookingDesignCatalogEvidencePort: "cover_assignment",
      async getBookingDesignCoverAssignmentEvidence() {
        return {
          outcome: "evidence",
          evidencePort: "cover_assignment",
          ...scope,
          source: source("property_media_assignment", propertyId, "profile:8"),
          cover: { mediaObjectId, altText: "Hotel" },
        } as any;
      },
    },
    safeMedia: {
      bookingDesignCatalogEvidencePort: "safe_media",
      async getBookingDesignSafeMediaEvidence() {
        return {
          outcome: "evidence",
          evidencePort: "safe_media",
          ...scope,
          source: source("property_safe_media", mediaObjectId, `media:${"b".repeat(64)}`),
          media: {
            mediaObjectId,
            ownerOrganizationId: organizationId,
            propertyId,
            purpose: "property.hero_image",
            publicVariants: [
              { variantName: "original_safe", publicUrl: "https://cdn.test/cover.webp" },
            ],
          },
        } as any;
      },
    },
  });
}

const catalogSource = (entityType: string, entityId: string, revision: string) => ({
  ownerDomain: "hotel_catalog" as const,
  entityType,
  entityId,
  revision,
});
const pmsSource = (entityType: string, entityId: string, revision: string) => ({
  ownerDomain: "pms" as const,
  entityType,
  entityId,
  revision,
});
const manifestRequest = (sources: readonly any[]) => ({
  ...scope,
  sourceManifestHash: hash,
  sourceManifest: {
    contractVersion: "onboarding-source-manifest.v1" as const,
    propertyId,
    sources,
  },
});
