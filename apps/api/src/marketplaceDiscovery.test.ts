import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  createPgMarketplaceDiscoveryReadRepository,
  findForbiddenMarketplaceDiscoveryKeys,
  type MarketplaceCreatorPage,
  type MarketplaceCreatorReadModel,
  type MarketplaceDiscoveryError,
  type MarketplaceDiscoveryPageRequest,
  type MarketplaceDiscoveryReadPool,
  type MarketplaceDiscoveryReadRepository,
  type MarketplaceListingPage,
  type MarketplaceListingReadModel,
} from "./routes/marketplaceDiscovery.js";

// In-memory repository mirroring the projection semantics from
// engineering/marketplace-discovery-contract.md: visibility/eligibility
// filtering and the documented createdAt DESC, id ASC ordering live in the
// repository layer, exactly as the pg implementation must behave.
type ListingSeed = MarketplaceListingReadModel & {
  visibilityStatus: "public" | "unlisted" | "private" | "disabled";
};

type CreatorSeed = Omit<MarketplaceCreatorReadModel, "audienceSize" | "creatorType"> & {
  creatorType: string;
  profileComplete: boolean;
  profileStatus: "pending" | "active" | "rejected" | "suspended" | "archived";
  displayNameRaw: string | null;
};

function createSeedRepository(seed: {
  listings?: ListingSeed[];
  creators?: CreatorSeed[];
}): MarketplaceDiscoveryReadRepository {
  const byCreatedAtDesc = (a: { createdAt: string }, b: { createdAt: string }, tiebreak: number) =>
    b.createdAt.localeCompare(a.createdAt) || tiebreak;

  return {
    async listPublicListings(page: MarketplaceDiscoveryPageRequest) {
      const eligible = (seed.listings ?? [])
        .filter((listing) => listing.visibilityStatus === "public")
        .sort((a, b) => byCreatedAtDesc(a, b, a.listingId.localeCompare(b.listingId)))
        .map((row) => {
          const { visibilityStatus, ...listing } = row;
          void visibilityStatus;
          return listing;
        });
      return {
        items: eligible.slice(page.offset, page.offset + page.limit),
        total: eligible.length,
      };
    },
    async listPublicCreators(page: MarketplaceDiscoveryPageRequest) {
      const eligible = (seed.creators ?? [])
        .filter(
          (creator) =>
            creator.profileComplete &&
            creator.profileStatus === "active" &&
            creator.displayNameRaw !== null,
        )
        .sort((a, b) => byCreatedAtDesc(a, b, a.creatorId.localeCompare(b.creatorId)))
        .map((row) => {
          const { profileComplete, profileStatus, displayNameRaw, creatorType, ...creator } = row;
          void profileComplete;
          void profileStatus;
          return {
            ...creator,
            displayName: displayNameRaw as string,
            creatorType: creatorType as MarketplaceCreatorReadModel["creatorType"],
          };
        });
      return {
        items: eligible.slice(page.offset, page.offset + page.limit),
        total: eligible.length,
      };
    },
  };
}

// Legacy UUIDs seeded as IDs per the contract's ID continuity clause.
const LEGACY_LISTING_ID_A = "3f1c2b6a-8a44-4f1e-9a51-1aa001000001";
const LEGACY_LISTING_ID_B = "3f1c2b6a-8a44-4f1e-9a51-1aa001000002";
const LEGACY_CREATOR_ID_A = "9d7e5c4b-1b23-4cde-8f00-2bb002000001";
const LEGACY_CREATOR_ID_B = "9d7e5c4b-1b23-4cde-8f00-2bb002000002";

function listingSeed(overrides: Partial<ListingSeed>): ListingSeed {
  return {
    listingId: LEGACY_LISTING_ID_A,
    publicId: "mlst_alpenrose",
    canonicalSlug: "hotel-alpenrose",
    displayName: "Hotel Alpenrose",
    listingTitle: "Alpine getaway collaboration",
    listingSummary: "Boutique alpine hotel.",
    accommodationType: "Hotel",
    location: { displayText: "Innsbruck, Austria", countryCode: "AT", city: "Innsbruck" },
    coverImageUrl: "https://cdn.example.com/alpenrose/cover.jpg",
    imageUrls: ["https://cdn.example.com/alpenrose/1.jpg"],
    offerings: [
      {
        offeringId: "off-1",
        collaborationType: "free_stay",
        availabilityMonths: ["June", "July"],
        platforms: ["instagram", "tiktok"],
        freeStayMinNights: 2,
        freeStayMaxNights: 4,
        paidMaxAmount: null,
        currency: null,
        discountPercentage: null,
        commissionPercentage: null,
        minFollowers: 10000,
      },
    ],
    creatorRequirements: {
      platforms: ["instagram"],
      targetCountries: ["AT", "DE"],
      targetAgeMin: 18,
      targetAgeMax: 45,
      targetAgeGroups: ["18-24", "25-34"],
    },
    createdAt: "2026-05-01T10:00:00.000Z",
    projectedAt: "2026-06-09T08:00:00.000Z",
    visibilityStatus: "public",
    ...overrides,
  };
}

function creatorSeed(overrides: Partial<CreatorSeed>): CreatorSeed {
  return {
    creatorId: LEGACY_CREATOR_ID_A,
    displayName: "Anna Alps",
    displayNameRaw: "Anna Alps",
    locationText: "Vienna, Austria",
    shortDescription: "Alpine travel storytelling.",
    portfolioUrl: "https://annaalps.example.com",
    profilePictureUrl: "https://cdn.example.com/anna.jpg",
    creatorType: "travel",
    platforms: [
      {
        platformId: "plat-1",
        platform: "instagram",
        handle: "@annaalps",
        followerCount: 12000,
        engagementRate: 4.2,
        audienceCountries: [{ country: "AT", percentage: 45 }],
        audienceAgeGroups: [{ ageRange: "25-34", percentage: 40 }],
        audienceGenderSplit: { male: 30, female: 70 },
      },
    ],
    averageRating: 4.5,
    totalReviews: 2,
    createdAt: "2026-04-15T09:00:00.000Z",
    profileComplete: true,
    profileStatus: "active",
    ...overrides,
  };
}

function createFakePool(results: unknown[][]): MarketplaceDiscoveryReadPool & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query(text) {
      sql.push(text);
      return { rows: (results.shift() ?? []) as never[] };
    },
    async end() {},
  };
}

let app: FastifyInstance | undefined;

async function buildDiscoveryApp(seed: {
  listings?: ListingSeed[];
  creators?: CreatorSeed[];
  allowedOrigins?: string[];
}): Promise<FastifyInstance> {
  app = buildApp({
    logger: false,
    marketplaceDiscoveryRepository: createSeedRepository(seed),
    marketplaceDiscoveryAllowedOrigins: seed.allowedOrigins,
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("marketplace discovery listings route", () => {
  it("returns public listings with contract fields and no private keys (listings-populated)", async () => {
    const server = await buildDiscoveryApp({
      listings: [
        listingSeed({}),
        listingSeed({
          listingId: LEGACY_LISTING_ID_B,
          publicId: "mlst_seehof",
          canonicalSlug: "hotel-seehof",
          createdAt: "2026-05-10T10:00:00.000Z",
        }),
      ],
    });

    const response = await injectJson<MarketplaceListingPage>(server, {
      method: "GET",
      url: "/api/marketplace/listings",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.pagination).toEqual({ limit: 100, offset: 0, total: 2 });

    for (const item of response.body.items) {
      for (const offering of item.offerings) {
        expect(["free_stay", "paid", "discount", "affiliate"]).toContain(
          offering.collaborationType,
        );
        for (const platform of offering.platforms) {
          expect(["instagram", "tiktok", "youtube", "facebook", "blog", "x", "other"]).toContain(
            platform,
          );
        }
      }
    }

    const [first] = response.body.items;
    expect(first.listingId).toBe(LEGACY_LISTING_ID_B);
    expect(first.publicId).toBe("mlst_seehof");
    expect(first.canonicalSlug).toBe("hotel-seehof");
    expect(first.displayName).toBe("Hotel Alpenrose");
    expect(first.listingTitle).toBe("Alpine getaway collaboration");
    expect(first.location.displayText).toBe("Innsbruck, Austria");
    expect(first.coverImageUrl).toContain("cover.jpg");
    expect(first.imageUrls).toHaveLength(1);
    expect(first.offerings[0].collaborationType).toBe("free_stay");
    expect(first.offerings[0].platforms).toEqual(["instagram", "tiktok"]);
    expect(first.creatorRequirements?.platforms).toEqual(["instagram"]);
    expect(first.createdAt).toBe("2026-05-10T10:00:00.000Z");
    expect(first.projectedAt).toBeTruthy();
    expect(response.body.items[1].listingId).toBe(LEGACY_LISTING_ID_A);

    expect(findForbiddenMarketplaceDiscoveryKeys(response.body)).toEqual([]);
    const raw = JSON.stringify(response.body);
    for (const forbidden of [
      "owner_email",
      "ownerEmail",
      "owner_user_id",
      "ownerUserId",
      "hotel_profile_id",
      '"status"',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("excludes non-public listings (listings-excludes-non-public)", async () => {
    const server = await buildDiscoveryApp({
      listings: [
        listingSeed({}),
        listingSeed({ listingId: "listing-private", visibilityStatus: "private" }),
        listingSeed({ listingId: "listing-unlisted", visibilityStatus: "unlisted" }),
        listingSeed({ listingId: "listing-disabled", visibilityStatus: "disabled" }),
        // Incomplete-profile hotel projects to a non-public visibility status.
        listingSeed({ listingId: "listing-incomplete-profile-hotel", visibilityStatus: "private" }),
      ],
    });

    const response = await injectJson<MarketplaceListingPage>(server, {
      method: "GET",
      url: "/api/marketplace/listings",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items.map((item) => item.listingId)).toEqual([LEGACY_LISTING_ID_A]);
  });

  it("returns an empty page when no public listings exist (listings-empty)", async () => {
    const server = await buildDiscoveryApp({ listings: [] });

    const response = await injectJson<MarketplaceListingPage>(server, {
      method: "GET",
      url: "/api/marketplace/listings",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(response.body.pagination.total).toBe(0);
  });

  it("slices the documented ordering with limit/offset (listings-pagination)", async () => {
    const server = await buildDiscoveryApp({
      listings: [
        listingSeed({ listingId: "lst-a", createdAt: "2026-05-03T00:00:00.000Z" }),
        // Same createdAt: listingId ASC is the documented tie-break.
        listingSeed({ listingId: "lst-c", createdAt: "2026-05-02T00:00:00.000Z" }),
        listingSeed({ listingId: "lst-b", createdAt: "2026-05-02T00:00:00.000Z" }),
      ],
    });

    const response = await injectJson<MarketplaceListingPage>(server, {
      method: "GET",
      url: "/api/marketplace/listings?limit=1&offset=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items.map((item) => item.listingId)).toEqual(["lst-b"]);
    expect(response.body.pagination).toEqual({ limit: 1, offset: 1, total: 3 });
  });

  it("clamps out-of-range pagination values (listings-clamps-out-of-range)", async () => {
    const server = await buildDiscoveryApp({ listings: [listingSeed({})] });

    const overMax = await injectJson<MarketplaceListingPage>(server, {
      method: "GET",
      url: "/api/marketplace/listings?limit=999&offset=-5",
    });
    expect(overMax.statusCode).toBe(200);
    expect(overMax.body.pagination.limit).toBe(200);
    expect(overMax.body.pagination.offset).toBe(0);

    const underMin = await injectJson<MarketplaceListingPage>(server, {
      method: "GET",
      url: "/api/marketplace/listings?limit=0",
    });
    expect(underMin.statusCode).toBe(200);
    expect(underMin.body.pagination.limit).toBe(1);

    const emptyValue = await injectJson<MarketplaceListingPage>(server, {
      method: "GET",
      url: "/api/marketplace/listings?limit=",
    });
    expect(emptyValue.statusCode).toBe(200);
    expect(emptyValue.body.pagination.limit).toBe(100);
  });

  it("rejects non-numeric and duplicated pagination values (listings-invalid-query)", async () => {
    const server = await buildDiscoveryApp({ listings: [listingSeed({})] });

    for (const url of [
      "/api/marketplace/listings?limit=abc",
      "/api/marketplace/listings?limit=1.5",
      "/api/marketplace/listings?limit=1&limit=2",
      "/api/marketplace/listings?offset=1&offset=2",
    ]) {
      const response = await injectJson<MarketplaceDiscoveryError>(server, { method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.body.code).toBe("invalid_query");
      expect(response.body.category).toBe("validation");
      expect(response.body.message).not.toContain("trim");
    }
  });

  it("reflects allowlisted origins, varies on Origin, and stays scoped (CORS)", async () => {
    const server = await buildDiscoveryApp({
      listings: [listingSeed({})],
      allowedOrigins: ["https://marketplace.localhost", "https://admin.localhost"],
    });

    for (const origin of ["https://marketplace.localhost", "https://admin.localhost"]) {
      const allowed = await server.inject({
        method: "GET",
        url: "/api/marketplace/listings",
        headers: { origin },
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe(origin);
      expect(allowed.headers.vary).toContain("Origin");
      expect(allowed.headers["cache-control"]).toBe(
        "public, max-age=60, stale-while-revalidate=300",
      );
    }

    const denied = await server.inject({
      method: "GET",
      url: "/api/marketplace/listings",
      headers: { origin: "https://evil.example.com" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    // Vary must be present even on non-allowlisted responses so shared
    // caches never replay an un-CORSed body to a browser consumer.
    expect(denied.headers.vary).toContain("Origin");

    const otherGroup = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://marketplace.localhost" },
    });
    expect(otherGroup.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("marketplace discovery creators route", () => {
  it("returns eligible creators with contract fields and no private keys (creators-populated)", async () => {
    const server = await buildDiscoveryApp({
      creators: [
        creatorSeed({}),
        creatorSeed({
          creatorId: LEGACY_CREATOR_ID_B,
          displayNameRaw: "Migrated Max",
          creatorType: "migration",
          createdAt: "2026-04-20T09:00:00.000Z",
        }),
      ],
    });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toHaveLength(2);

    const [migrated, anna] = response.body.items;
    expect(migrated.creatorId).toBe(LEGACY_CREATOR_ID_B);
    expect(migrated.creatorType).toBe("other");
    expect(migrated.displayName).toBe("Migrated Max");
    expect(anna.creatorId).toBe(LEGACY_CREATOR_ID_A);
    expect(anna.displayName).toBe("Anna Alps");
    expect(anna.creatorType).toBe("travel");
    expect(anna.platforms[0].platform).toBe("instagram");
    expect(anna.platforms[0].handle).toBe("@annaalps");
    expect(anna.platforms[0].followerCount).toBe(12000);
    expect(anna.platforms[0].engagementRate).toBe(4.2);
    expect(anna.audienceSize).toBe(12000);
    expect(anna.averageRating).toBe(4.5);
    expect(anna.totalReviews).toBe(2);
    expect(anna.createdAt).toBe("2026-04-15T09:00:00.000Z");

    expect(findForbiddenMarketplaceDiscoveryKeys(response.body)).toEqual([]);
    const raw = JSON.stringify(response.body);
    for (const forbidden of ["user_id", "userId", "email", "phone"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("computes audience and rating aggregates (creators-audience-aggregates)", async () => {
    const server = await buildDiscoveryApp({
      creators: [
        creatorSeed({
          platforms: [
            { ...creatorSeed({}).platforms[0], platformId: "p1", followerCount: 12000 },
            {
              ...creatorSeed({}).platforms[0],
              platformId: "p2",
              platform: "tiktok",
              followerCount: 8000,
            },
          ],
          averageRating: 4.33,
          totalReviews: 3,
        }),
      ],
    });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items[0].audienceSize).toBe(20000);
    expect(response.body.items[0].averageRating).toBe(4.33);
    expect(response.body.items[0].totalReviews).toBe(3);
  });

  it("returns creators with no platforms (creators-empty-platforms)", async () => {
    const server = await buildDiscoveryApp({
      creators: [creatorSeed({ platforms: [] })],
    });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items[0].platforms).toEqual([]);
    expect(response.body.items[0].audienceSize).toBe(0);
  });

  it("excludes ineligible creators (creators-excludes-ineligible)", async () => {
    const server = await buildDiscoveryApp({
      creators: [
        creatorSeed({}),
        creatorSeed({ creatorId: "creator-incomplete-profile", profileComplete: false }),
        creatorSeed({ creatorId: "creator-pending-status", profileStatus: "pending" }),
        creatorSeed({ creatorId: "creator-rejected-status", profileStatus: "rejected" }),
        creatorSeed({ creatorId: "creator-suspended-status", profileStatus: "suspended" }),
        creatorSeed({ creatorId: "creator-archived-status", profileStatus: "archived" }),
        creatorSeed({ creatorId: "creator-null-display-name", displayNameRaw: null }),
      ],
    });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items.map((item) => item.creatorId)).toEqual([LEGACY_CREATOR_ID_A]);
  });

  it("returns an empty page when no eligible creators exist (creators-empty)", async () => {
    const server = await buildDiscoveryApp({ creators: [] });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(response.body.pagination.total).toBe(0);
  });

  it("returns the contract error envelope on repository failure", async () => {
    app = buildApp({
      logger: false,
      marketplaceDiscoveryRepository: {
        async listPublicListings() {
          throw new Error("boom");
        },
        async listPublicCreators() {
          throw new Error("boom");
        },
      },
    });
    await app.ready();

    const creators = await injectJson<MarketplaceDiscoveryError>(app, {
      method: "GET",
      url: "/api/marketplace/creators",
    });
    expect(creators.statusCode).toBe(500);
    expect(creators.body).toEqual({
      statusCode: 500,
      code: "internal_error",
      category: "internal",
      message: "Failed to fetch marketplace creators.",
    });

    const listings = await injectJson<MarketplaceDiscoveryError>(app, {
      method: "GET",
      url: "/api/marketplace/listings",
    });
    expect(listings.statusCode).toBe(500);
    expect(listings.body).toEqual({
      statusCode: 500,
      code: "internal_error",
      category: "internal",
      message: "Failed to fetch marketplace listings.",
    });
  });
});

describe("marketplace discovery public-safety guard", () => {
  it("flags forbidden keys anywhere in a payload", () => {
    expect(
      findForbiddenMarketplaceDiscoveryKeys({
        items: [{ ownerEmail: "x@example.com" }],
      }),
    ).toEqual(["$.items[0].ownerEmail"]);
    expect(findForbiddenMarketplaceDiscoveryKeys({ nested: { owner_user_id: "u1" } })).toEqual([
      "$.nested.owner_user_id",
    ]);
    expect(findForbiddenMarketplaceDiscoveryKeys({ status: "pending" })).toEqual(["$.status"]);
    expect(findForbiddenMarketplaceDiscoveryKeys({ phone: "+43" })).toEqual(["$.phone"]);
  });

  it("does not register the routes when no repository is provided", async () => {
    app = buildApp({ logger: false });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/marketplace/listings" });
    expect(response.statusCode).toBe(404);
  });

  it("mounts listings and creators in target mode without the legacy marketplace DB", async () => {
    const config = loadConfig({
      TARGET_DATABASE_URL: "postgresql://target-db",
      MARKETPLACE_DISCOVERY_SOURCE: "target",
    });
    expect(config.marketplaceDiscoverySource).toBe("target");

    const pool = createFakePool([
      [
        {
          listingId: LEGACY_LISTING_ID_A,
          publicId: "mlst_alpenrose",
          canonicalSlug: "hotel-alpenrose",
          displayName: "Hotel Alpenrose",
          listingTitle: "Alpine getaway collaboration",
          listingSummary: "Boutique alpine hotel.",
          accommodationType: "boutique_hotel",
          location: { display: "Innsbruck, Austria", countryCode: "AT", city: "Innsbruck" },
          coverImageUrl: "https://cdn.example.com/cover.jpg",
          imageUrls: ["https://cdn.example.com/listing.jpg"],
          offerings: [],
          creatorRequirements: null,
          createdAt: new Date("2026-05-01T10:00:00.000Z"),
          projectedAt: new Date("2026-06-01T10:00:00.000Z"),
        },
      ],
      [{ total: "1" }],
      [
        {
          creatorId: LEGACY_CREATOR_ID_A,
          displayName: "Anna Alps",
          locationText: "Vienna, Austria",
          shortDescription: "Alpine travel storytelling.",
          portfolioUrl: "https://annaalps.example.com",
          profilePictureUrl: "https://cdn.example.com/anna.jpg",
          creatorType: "travel",
          platforms: [],
          averageRating: "0",
          totalReviews: "0",
          createdAt: "2026-04-15T09:00:00.000Z",
        },
      ],
      [{ total: "1" }],
    ]);
    app = buildApp({
      logger: false,
      marketplaceDiscoveryRepository: createPgMarketplaceDiscoveryReadRepository({
        connectionString: config.targetDatabaseUrl!,
        pool,
      }),
    });

    const listings = await injectJson<MarketplaceListingPage>(app, {
      method: "GET",
      url: "/api/marketplace/listings",
    });
    const creators = await injectJson<MarketplaceCreatorPage>(app, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(listings.statusCode).toBe(200);
    expect(listings.body.items[0]?.listingId).toBe(LEGACY_LISTING_ID_A);
    expect(creators.statusCode).toBe(200);
    expect(creators.body.items[0]?.creatorId).toBe(LEGACY_CREATOR_ID_A);
    const sql = pool.sql.join("\n");
    expect(sql).toContain('listing.source_listing_id AS "listingId"');
    expect(sql).toContain("listing.source_listing_id IS NOT NULL");
    expect(sql).toContain('creator.source_creator_id AS "creatorId"');
    expect(sql).toContain("creator.source_creator_id IS NOT NULL");
    expect(sql).not.toContain("COALESCE(listing.source_listing_id");
    expect(sql).not.toContain("COALESCE(creator.source_creator_id");
  });
});

describe("pg marketplace discovery repository", () => {
  it("maps public listing read-model rows with legacy IDs and total", async () => {
    const pool = createFakePool([
      [
        {
          listingId: LEGACY_LISTING_ID_A,
          publicId: "mlst_alpenrose",
          canonicalSlug: "hotel-alpenrose",
          displayName: "Hotel Alpenrose",
          listingTitle: "Alpine getaway collaboration",
          listingSummary: "Boutique alpine hotel.",
          accommodationType: "boutique_hotel",
          location: { display: "Innsbruck, Austria", countryCode: "AT", city: "Innsbruck" },
          coverImageUrl: "https://cdn.example.com/cover.jpg",
          imageUrls: ["https://cdn.example.com/listing.jpg"],
          offerings: [
            {
              id: "offering-1",
              type: "affiliate",
              months: ["June"],
              platforms: ["instagram"],
              commissionPercent: 12,
              minFollowers: 5000,
            },
          ],
          creatorRequirements: {
            platforms: ["instagram"],
            countries: ["AT"],
            targetAgeMin: 20,
            targetAgeMax: 40,
            ageGroups: ["25-34"],
          },
          createdAt: new Date("2026-05-01T10:00:00.000Z"),
          projectedAt: new Date("2026-06-01T10:00:00.000Z"),
        },
      ],
      [{ total: "3" }],
    ]);
    const repository = createPgMarketplaceDiscoveryReadRepository({
      connectionString: "postgresql://marketplace-db",
      pool,
    });

    const result = await repository.listPublicListings({ limit: 1, offset: 2 });

    expect(result.total).toBe(3);
    expect(result.items[0]).toMatchObject({
      listingId: LEGACY_LISTING_ID_A,
      publicId: "mlst_alpenrose",
      canonicalSlug: "hotel-alpenrose",
      coverImageUrl: "https://cdn.example.com/cover.jpg",
      location: { displayText: "Innsbruck, Austria", countryCode: "AT", city: "Innsbruck" },
      imageUrls: ["https://cdn.example.com/listing.jpg"],
      offerings: [
        {
          offeringId: "offering-1",
          collaborationType: "affiliate",
          availabilityMonths: ["June"],
          platforms: ["instagram"],
          commissionPercentage: 12,
          minFollowers: 5000,
        },
      ],
      creatorRequirements: {
        platforms: ["instagram"],
        targetCountries: ["AT"],
        targetAgeMin: 20,
        targetAgeMax: 40,
        targetAgeGroups: ["25-34"],
      },
      createdAt: "2026-05-01T10:00:00.000Z",
      projectedAt: "2026-06-01T10:00:00.000Z",
    });
    expect(pool.sql.join("\n")).toContain("read_model.visibility_status = 'public'");
    expect(pool.sql.join("\n")).toContain('listing.source_listing_id AS "listingId"');
    expect(pool.sql.join("\n")).toContain("listing.source_listing_id IS NOT NULL");
    expect(pool.sql.join("\n")).toContain("property_public_profile_read_model");
    expect(pool.sql.join("\n")).toContain("platformMediaObjectId");
    expect(pool.sql.join("\n")).not.toMatch(/\bauth\b|users/i);
  });

  it("maps active creator rows with source IDs, platforms, and rounded ratings", async () => {
    const pool = createFakePool([
      [
        {
          creatorId: LEGACY_CREATOR_ID_A,
          displayName: "Anna Alps",
          locationText: "Vienna, Austria",
          shortDescription: "Alpine travel storytelling.",
          portfolioUrl: "https://annaalps.example.com",
          profilePictureUrl: "https://cdn.example.com/anna.jpg",
          creatorType: "migration",
          platforms: [
            {
              platformId: "platform-1",
              platform: "instagram",
              handle: "@annaalps",
              followerCount: 12000,
              engagementRate: "4.20",
              audienceCountries: [{ country: "AT", percentage: 45 }],
              audienceAgeGroups: [{ ageRange: "25-34", percentage: 40 }],
              audienceGenderSplit: { male: 30, female: 70 },
            },
          ],
          averageRating: "4.33",
          totalReviews: "3",
          createdAt: "2026-04-15T09:00:00.000Z",
        },
      ],
      [{ total: "1" }],
    ]);
    const repository = createPgMarketplaceDiscoveryReadRepository({
      connectionString: "postgresql://marketplace-db",
      pool,
    });

    const result = await repository.listPublicCreators({ limit: 100, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      creatorId: LEGACY_CREATOR_ID_A,
      displayName: "Anna Alps",
      creatorType: "other",
      averageRating: 4.33,
      totalReviews: 3,
      platforms: [
        {
          platformId: "platform-1",
          platform: "instagram",
          handle: "@annaalps",
          followerCount: 12000,
          engagementRate: 4.2,
        },
      ],
    });
    const sql = pool.sql.join("\n");
    expect(sql).toContain("creator.profile_complete = TRUE");
    expect(sql).toContain("creator.profile_status = 'active'");
    expect(sql).toContain('creator.source_creator_id AS "creatorId"');
    expect(sql).toContain("creator.source_creator_id IS NOT NULL");
    expect(sql).not.toContain("COALESCE(creator.source_creator_id");
    expect(sql).not.toMatch(/\bauth\b|users/i);
  });
});
