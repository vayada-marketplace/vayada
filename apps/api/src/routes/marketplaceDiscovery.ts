import type { FastifyInstance, FastifyReply } from "fastify";

export const MARKETPLACE_LISTINGS_CONTRACT = {
  method: "GET",
  path: "/api/marketplace/listings",
  doc: "engineering/marketplace-discovery-contract.md",
} as const;

export const MARKETPLACE_CREATORS_CONTRACT = {
  method: "GET",
  path: "/api/marketplace/creators",
  doc: "engineering/marketplace-discovery-contract.md",
} as const;

export const MARKETPLACE_DISCOVERY_DEFAULT_LIMIT = 100;
export const MARKETPLACE_DISCOVERY_MIN_LIMIT = 1;
export const MARKETPLACE_DISCOVERY_MAX_LIMIT = 200;

export type MarketplacePlatformName =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "blog"
  | "x"
  | "other";

export type MarketplaceOfferingSummary = {
  offeringId: string;
  collaborationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: MarketplacePlatformName[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null;
  currency: string | null;
  discountPercentage: number | null;
  commissionPercentage: number | null;
  minFollowers: number | null;
};

export type MarketplaceCreatorRequirements = {
  platforms: MarketplacePlatformName[];
  targetCountries: string[];
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[] | null;
};

export type MarketplaceListingReadModel = {
  listingId: string;
  publicId: string;
  canonicalSlug: string;
  displayName: string;
  listingTitle: string;
  listingSummary: string | null;
  accommodationType: string | null;
  location: { displayText: string; countryCode?: string; city?: string };
  coverImageUrl: string | null;
  imageUrls: string[];
  offerings: MarketplaceOfferingSummary[];
  creatorRequirements: MarketplaceCreatorRequirements | null;
  createdAt: string;
  projectedAt: string;
};

export type MarketplaceCreatorPlatform = {
  platformId: string;
  platform: MarketplacePlatformName;
  handle: string;
  followerCount: number;
  engagementRate: number;
  audienceCountries: { country: string; percentage: number }[];
  audienceAgeGroups: { ageRange: string; percentage: number }[];
  audienceGenderSplit: { male: number; female: number; other?: number } | null;
};

export type MarketplaceCreatorReadModel = {
  creatorId: string;
  displayName: string;
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  profilePictureUrl: string | null;
  creatorType: "lifestyle" | "travel" | "other";
  platforms: MarketplaceCreatorPlatform[];
  audienceSize: number;
  averageRating: number;
  totalReviews: number;
  createdAt: string;
};

export type MarketplaceDiscoveryPagination = {
  limit: number;
  offset: number;
  total: number;
};

export type MarketplaceListingPage = {
  items: MarketplaceListingReadModel[];
  pagination: MarketplaceDiscoveryPagination;
};

export type MarketplaceCreatorPage = {
  items: MarketplaceCreatorReadModel[];
  pagination: MarketplaceDiscoveryPagination;
};

export type MarketplaceDiscoveryError = {
  statusCode: 400 | 500;
  code: "invalid_query" | "internal_error";
  category: "validation" | "internal";
  message: string;
};

export type MarketplaceDiscoveryPageRequest = {
  limit: number;
  offset: number;
};

// Repository obligations (engineering/marketplace-discovery-contract.md):
// - listings: only visibility_status = 'public' rows, ordered
//   createdAt DESC, listingId ASC; total counts the full eligible set.
// - creators: only profile_complete, profile_status = 'active', non-null
//   display_name rows, ordered createdAt DESC, creatorId ASC;
//   averageRating rounded to 2 decimals over creator_ratings rows.
// - IDs are the LEGACY marketplace UUIDs (ID continuity clause), not
//   target-schema primary keys.
export type MarketplaceDiscoveryReadRepository = {
  listPublicListings(
    page: MarketplaceDiscoveryPageRequest,
  ): Promise<{ items: MarketplaceListingReadModel[]; total: number }>;
  listPublicCreators(
    page: MarketplaceDiscoveryPageRequest,
  ): Promise<{ items: Omit<MarketplaceCreatorReadModel, "audienceSize">[]; total: number }>;
  close?(): Promise<void>;
};

export type MarketplaceDiscoveryRoutesOptions = {
  repository: MarketplaceDiscoveryReadRepository;
  allowedOrigins?: string[];
};

type DiscoveryQuery = {
  limit?: string | string[];
  offset?: string | string[];
};

// Public routes: documented exception to the enforceRoutePolicy requirement
// (engineering/marketplace-discovery-contract.md, Authorization). No
// RequestContext, no tenant scope; the repository must only ever surface
// public-eligible rows.
export async function registerMarketplaceDiscoveryRoutes(
  app: FastifyInstance,
  options: MarketplaceDiscoveryRoutesOptions,
): Promise<void> {
  const { repository } = options;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  // GET-only simple requests need no preflight; reflecting the allowlisted
  // Origin is the entire CORS surface for this group. Vary must be set on
  // every response (not just allowlisted ones) or shared caches replay
  // un-CORSed responses to browser consumers.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
    }
  });

  app.get<{ Querystring: DiscoveryQuery }>("/listings", async (request, reply) => {
    const page = parsePageQuery(request.query);
    if ("error" in page) {
      return sendDiscoveryError(reply, page.error);
    }

    try {
      const { items, total } = await repository.listPublicListings(page);
      const response: MarketplaceListingPage = {
        items: items.map(serializeMarketplaceListing),
        pagination: { limit: page.limit, offset: page.offset, total },
      };
      assertMarketplaceDiscoveryPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return response;
    } catch (error) {
      request.log.error({ err: error }, "marketplace discovery listings read failed");
      return sendDiscoveryError(reply, internalError("Failed to fetch marketplace listings."));
    }
  });

  app.get<{ Querystring: DiscoveryQuery }>("/creators", async (request, reply) => {
    const page = parsePageQuery(request.query);
    if ("error" in page) {
      return sendDiscoveryError(reply, page.error);
    }

    try {
      const { items, total } = await repository.listPublicCreators(page);
      const response: MarketplaceCreatorPage = {
        items: items.map(serializeMarketplaceCreator),
        pagination: { limit: page.limit, offset: page.offset, total },
      };
      assertMarketplaceDiscoveryPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return response;
    } catch (error) {
      request.log.error({ err: error }, "marketplace discovery creators read failed");
      return sendDiscoveryError(reply, internalError("Failed to fetch marketplace creators."));
    }
  });
}

export function parsePageQuery(
  query: DiscoveryQuery,
): MarketplaceDiscoveryPageRequest | { error: MarketplaceDiscoveryError } {
  const limit = parsePageParameter(query.limit, "limit");
  if (typeof limit !== "number" && limit !== undefined) return limit;
  const offset = parsePageParameter(query.offset, "offset");
  if (typeof offset !== "number" && offset !== undefined) return offset;

  return {
    limit: clamp(
      limit ?? MARKETPLACE_DISCOVERY_DEFAULT_LIMIT,
      MARKETPLACE_DISCOVERY_MIN_LIMIT,
      MARKETPLACE_DISCOVERY_MAX_LIMIT,
    ),
    offset: clamp(offset ?? 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function parsePageParameter(
  raw: string | string[] | undefined,
  name: "limit" | "offset",
): number | undefined | { error: MarketplaceDiscoveryError } {
  if (raw === undefined || raw === "") return undefined;
  if (Array.isArray(raw) || !/^-?\d+$/.test(raw.trim())) {
    return {
      error: {
        statusCode: 400,
        code: "invalid_query",
        category: "validation",
        message: `Query parameter "${name}" must be a single integer.`,
      },
    };
  }
  return Number.parseInt(raw, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function internalError(message: string): MarketplaceDiscoveryError {
  return { statusCode: 500, code: "internal_error", category: "internal", message };
}

function sendDiscoveryError(
  reply: FastifyReply,
  error: MarketplaceDiscoveryError,
): MarketplaceDiscoveryError {
  void reply.status(error.statusCode);
  return error;
}

export function serializeMarketplaceListing(
  listing: MarketplaceListingReadModel,
): MarketplaceListingReadModel {
  return {
    listingId: listing.listingId,
    publicId: listing.publicId,
    canonicalSlug: listing.canonicalSlug,
    displayName: listing.displayName,
    listingTitle: listing.listingTitle,
    listingSummary: listing.listingSummary ?? null,
    accommodationType: listing.accommodationType ?? null,
    location: {
      displayText: listing.location.displayText,
      ...(listing.location.countryCode ? { countryCode: listing.location.countryCode } : {}),
      ...(listing.location.city ? { city: listing.location.city } : {}),
    },
    coverImageUrl: listing.coverImageUrl ?? null,
    imageUrls: listing.imageUrls.map((url) => url),
    offerings: listing.offerings.map(serializeOffering),
    creatorRequirements: listing.creatorRequirements
      ? serializeCreatorRequirements(listing.creatorRequirements)
      : null,
    createdAt: listing.createdAt,
    projectedAt: listing.projectedAt,
  };
}

export function serializeMarketplaceCreator(
  creator: Omit<MarketplaceCreatorReadModel, "audienceSize">,
): MarketplaceCreatorReadModel {
  const platforms = creator.platforms.map(serializeCreatorPlatform);
  return {
    creatorId: creator.creatorId,
    displayName: creator.displayName,
    locationText: creator.locationText ?? null,
    shortDescription: creator.shortDescription ?? null,
    portfolioUrl: creator.portfolioUrl ?? null,
    profilePictureUrl: creator.profilePictureUrl ?? null,
    creatorType: toPublicCreatorType(creator.creatorType),
    platforms,
    audienceSize: platforms.reduce((sum, platform) => sum + platform.followerCount, 0),
    averageRating: creator.averageRating,
    totalReviews: creator.totalReviews,
    createdAt: creator.createdAt,
  };
}

// DDL allows 'migration' on creator_profiles.creator_type; the public enum
// does not include it (contract: maps to "other").
export function toPublicCreatorType(value: string): "lifestyle" | "travel" | "other" {
  return value === "lifestyle" || value === "travel" ? value : "other";
}

function serializeCreatorPlatform(
  platform: MarketplaceCreatorPlatform,
): MarketplaceCreatorPlatform {
  return {
    platformId: platform.platformId,
    platform: platform.platform,
    handle: platform.handle,
    followerCount: platform.followerCount,
    engagementRate: platform.engagementRate,
    audienceCountries: platform.audienceCountries.map((entry) => ({
      country: entry.country,
      percentage: entry.percentage,
    })),
    audienceAgeGroups: platform.audienceAgeGroups.map((entry) => ({
      ageRange: entry.ageRange,
      percentage: entry.percentage,
    })),
    audienceGenderSplit: platform.audienceGenderSplit
      ? {
          male: platform.audienceGenderSplit.male,
          female: platform.audienceGenderSplit.female,
          ...(platform.audienceGenderSplit.other !== undefined
            ? { other: platform.audienceGenderSplit.other }
            : {}),
        }
      : null,
  };
}

function serializeOffering(offering: MarketplaceOfferingSummary): MarketplaceOfferingSummary {
  return {
    offeringId: offering.offeringId,
    collaborationType: offering.collaborationType,
    availabilityMonths: offering.availabilityMonths.map((month) => month),
    platforms: offering.platforms.map((platform) => platform),
    freeStayMinNights: offering.freeStayMinNights ?? null,
    freeStayMaxNights: offering.freeStayMaxNights ?? null,
    paidMaxAmount: offering.paidMaxAmount ?? null,
    currency: offering.currency ?? null,
    discountPercentage: offering.discountPercentage ?? null,
    commissionPercentage: offering.commissionPercentage ?? null,
    minFollowers: offering.minFollowers ?? null,
  };
}

function serializeCreatorRequirements(
  requirements: MarketplaceCreatorRequirements,
): MarketplaceCreatorRequirements {
  return {
    platforms: requirements.platforms.map((platform) => platform),
    targetCountries: requirements.targetCountries.map((country) => country),
    targetAgeMin: requirements.targetAgeMin ?? null,
    targetAgeMax: requirements.targetAgeMax ?? null,
    targetAgeGroups: requirements.targetAgeGroups?.map((group) => group) ?? null,
  };
}

const FORBIDDEN_KEY_PATTERN =
  /(email|phone|user[_-]?id|owner|hotel_profile_id|pii|profile_?metadata|status$)/i;

export function findForbiddenMarketplaceDiscoveryKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findForbiddenMarketplaceDiscoveryKeys(item, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const childPath = `${path}.${key}`;
      const own = FORBIDDEN_KEY_PATTERN.test(key) ? [childPath] : [];
      return [...own, ...findForbiddenMarketplaceDiscoveryKeys(child, childPath)];
    });
  }
  return [];
}

export function assertMarketplaceDiscoveryPublicSafe(payload: unknown): void {
  const forbidden = findForbiddenMarketplaceDiscoveryKeys(payload);
  if (forbidden.length > 0) {
    throw new Error(
      `Marketplace discovery payload contains forbidden public keys: ${forbidden.join(", ")}`,
    );
  }
}
