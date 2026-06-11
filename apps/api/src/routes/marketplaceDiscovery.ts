import type { FastifyInstance, FastifyReply } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

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

export type MarketplaceDiscoveryReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type MarketplaceListingRow = {
  listingId: string;
  publicId: string;
  canonicalSlug: string;
  displayName: string;
  listingTitle: string;
  listingSummary: string | null;
  accommodationType: string | null;
  location: unknown;
  coverImageUrl: string | null;
  imageUrls: string[] | null;
  offerings: unknown;
  creatorRequirements: unknown;
  createdAt: Date | string;
  projectedAt: Date | string;
};

type MarketplaceCreatorRow = {
  creatorId: string;
  displayName: string;
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  profilePictureUrl: string | null;
  creatorType: string;
  platforms: unknown;
  averageRating: number | string | null;
  totalReviews: number | string | null;
  createdAt: Date | string;
};

export function createPgMarketplaceDiscoveryReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: MarketplaceDiscoveryReadPool;
}): MarketplaceDiscoveryReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace discovery repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listPublicListings(page) {
      const [listingResult, countResult] = await Promise.all([
        pool.query<MarketplaceListingRow>(
          `SELECT
             listing.source_listing_id AS "listingId",
             read_model.public_id AS "publicId",
             read_model.canonical_slug AS "canonicalSlug",
             read_model.display_name AS "displayName",
             read_model.listing_title AS "listingTitle",
             read_model.listing_summary AS "listingSummary",
             read_model.accommodation_type AS "accommodationType",
             read_model.location,
             media.cover_image_url AS "coverImageUrl",
             read_model.image_urls AS "imageUrls",
             read_model.public_offering_summary AS offerings,
             read_model.public_creator_requirements AS "creatorRequirements",
             listing.created_at AS "createdAt",
             read_model.projected_at AS "projectedAt"
           FROM marketplace.marketplace_listing_read_model read_model
           JOIN marketplace.marketplace_hotel_listings listing
             ON listing.id = read_model.listing_id
            AND listing.property_id = read_model.property_id
           LEFT JOIN hotel_catalog.property_public_profile_read_model property_profile
             ON property_profile.property_id = read_model.property_id
           LEFT JOIN LATERAL (
             SELECT media_entry->>'url' AS cover_image_url
             FROM jsonb_array_elements(COALESCE(property_profile.media, '[]'::jsonb)) media_entry
             WHERE media_entry->>'type' IN ('hero_image', 'gallery_image')
             ORDER BY CASE WHEN media_entry->>'type' = 'hero_image' THEN 0 ELSE 1 END
             LIMIT 1
           ) media ON TRUE
           WHERE read_model.visibility_status = 'public'
             AND listing.source_listing_id IS NOT NULL
           ORDER BY listing.created_at DESC, listing.source_listing_id ASC
           LIMIT $1 OFFSET $2`,
          [page.limit, page.offset],
        ),
        pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
           FROM marketplace.marketplace_listing_read_model read_model
           JOIN marketplace.marketplace_hotel_listings listing
             ON listing.id = read_model.listing_id
            AND listing.property_id = read_model.property_id
           WHERE read_model.visibility_status = 'public'
             AND listing.source_listing_id IS NOT NULL`,
        ),
      ]);

      return {
        items: listingResult.rows.map(mapMarketplaceListingRow),
        total: parseCount(countResult.rows[0]?.total),
      };
    },
    async listPublicCreators(page) {
      const [creatorResult, countResult] = await Promise.all([
        pool.query<MarketplaceCreatorRow>(
          `SELECT
             creator.source_creator_id AS "creatorId",
             creator.display_name AS "displayName",
             creator.location_text AS "locationText",
             creator.short_description AS "shortDescription",
             creator.portfolio_url AS "portfolioUrl",
             creator.profile_picture_url AS "profilePictureUrl",
             creator.creator_type AS "creatorType",
             COALESCE(platforms.platforms, '[]'::jsonb) AS platforms,
             COALESCE(ROUND(ratings.average_rating::numeric, 2), 0) AS "averageRating",
             COALESCE(ratings.total_reviews, 0)::text AS "totalReviews",
             creator.created_at AS "createdAt"
           FROM marketplace.creator_profiles creator
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(
                      jsonb_build_object(
                        'platformId', platform.id::text,
                        'platform', platform.platform,
                        'handle', platform.handle,
                        'followerCount', platform.follower_count,
                        'engagementRate', platform.engagement_rate,
                        'audienceCountries', platform.audience_countries,
                        'audienceAgeGroups', platform.audience_age_groups,
                        'audienceGenderSplit', platform.audience_gender_split
                      )
                      ORDER BY platform.created_at DESC, platform.id ASC
                    ) AS platforms
             FROM marketplace.creator_platforms platform
             WHERE platform.creator_profile_id = creator.id
               AND platform.organization_id = creator.organization_id
           ) platforms ON TRUE
           LEFT JOIN LATERAL (
             SELECT AVG(rating.rating) AS average_rating,
                    COUNT(*) AS total_reviews
             FROM marketplace.creator_ratings rating
             WHERE rating.creator_profile_id = creator.id
               AND rating.creator_organization_id = creator.organization_id
           ) ratings ON TRUE
           WHERE creator.profile_complete = TRUE
             AND creator.profile_status = 'active'
             AND creator.display_name IS NOT NULL
             AND creator.source_creator_id IS NOT NULL
           ORDER BY creator.created_at DESC, creator.source_creator_id ASC
           LIMIT $1 OFFSET $2`,
          [page.limit, page.offset],
        ),
        pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
           FROM marketplace.creator_profiles creator
           WHERE creator.profile_complete = TRUE
             AND creator.profile_status = 'active'
             AND creator.display_name IS NOT NULL
             AND creator.source_creator_id IS NOT NULL`,
        ),
      ]);

      return {
        items: creatorResult.rows.map(mapMarketplaceCreatorRow),
        total: parseCount(countResult.rows[0]?.total),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

function mapMarketplaceListingRow(row: MarketplaceListingRow): MarketplaceListingReadModel {
  return {
    listingId: row.listingId,
    publicId: row.publicId,
    canonicalSlug: row.canonicalSlug,
    displayName: row.displayName,
    listingTitle: row.listingTitle,
    listingSummary: row.listingSummary,
    accommodationType: row.accommodationType,
    location: toMarketplaceLocation(row.location),
    coverImageUrl: row.coverImageUrl,
    imageUrls: Array.isArray(row.imageUrls) ? row.imageUrls : [],
    offerings: toMarketplaceOfferings(row.offerings),
    creatorRequirements: toMarketplaceCreatorRequirements(row.creatorRequirements),
    createdAt: toIsoString(row.createdAt),
    projectedAt: toIsoString(row.projectedAt),
  };
}

function mapMarketplaceCreatorRow(
  row: MarketplaceCreatorRow,
): Omit<MarketplaceCreatorReadModel, "audienceSize"> {
  return {
    creatorId: row.creatorId,
    displayName: row.displayName,
    locationText: row.locationText,
    shortDescription: row.shortDescription,
    portfolioUrl: row.portfolioUrl,
    profilePictureUrl: row.profilePictureUrl,
    creatorType: toPublicCreatorType(row.creatorType),
    platforms: toMarketplaceCreatorPlatforms(row.platforms),
    averageRating: toNumber(row.averageRating),
    totalReviews: parseCount(row.totalReviews),
    createdAt: toIsoString(row.createdAt),
  };
}

function toMarketplaceLocation(value: unknown): MarketplaceListingReadModel["location"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { displayText: "" };
  }
  const location = value as Record<string, unknown>;
  const displayText = readString(location.displayText) ?? readString(location.display) ?? "";
  const countryCode = readString(location.countryCode);
  const city = readString(location.city);
  return {
    displayText,
    ...(countryCode ? { countryCode } : {}),
    ...(city ? { city } : {}),
  };
}

function toMarketplaceOfferings(value: unknown): MarketplaceOfferingSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((offering) => {
    const row = isRecord(offering) ? offering : {};
    const nights = isRecord(row.nights) ? row.nights : {};
    const collaborationType = readString(row.collaborationType) ?? readString(row.type);
    return {
      offeringId: readString(row.offeringId) ?? readString(row.id) ?? "",
      collaborationType: toCollaborationType(collaborationType),
      availabilityMonths: toStringArray(row.availabilityMonths ?? row.months),
      platforms: toPlatformArray(row.platforms),
      freeStayMinNights: toNullableNumber(row.freeStayMinNights ?? nights.min),
      freeStayMaxNights: toNullableNumber(row.freeStayMaxNights ?? nights.max),
      paidMaxAmount: readString(row.paidMaxAmount),
      currency: readString(row.currency),
      discountPercentage: toNullableNumber(row.discountPercentage),
      commissionPercentage: toNullableNumber(row.commissionPercentage ?? row.commissionPercent),
      minFollowers: toNullableNumber(row.minFollowers),
    };
  });
}

function toMarketplaceCreatorRequirements(value: unknown): MarketplaceCreatorRequirements | null {
  if (!value || !isRecord(value)) return null;
  return {
    platforms: toPlatformArray(value.platforms),
    targetCountries: toStringArray(value.targetCountries ?? value.countries),
    targetAgeMin: toNullableNumber(value.targetAgeMin),
    targetAgeMax: toNullableNumber(value.targetAgeMax),
    targetAgeGroups:
      value.targetAgeGroups === null
        ? null
        : toStringArray(value.targetAgeGroups ?? value.ageGroups),
  };
}

function toMarketplaceCreatorPlatforms(value: unknown): MarketplaceCreatorPlatform[] {
  if (!Array.isArray(value)) return [];
  return value.map((platform) => {
    const row = isRecord(platform) ? platform : {};
    const platformName = readString(row.platform) ?? readString(row.name);
    return {
      platformId: readString(row.platformId) ?? readString(row.id) ?? "",
      platform: toPlatformName(platformName),
      handle: readString(row.handle) ?? "",
      followerCount: toNumber(row.followerCount ?? row.followers),
      engagementRate: toNumber(row.engagementRate ?? row.engagement_rate),
      audienceCountries: toAudienceCountries(row.audienceCountries ?? row.top_countries),
      audienceAgeGroups: toAudienceAgeGroups(row.audienceAgeGroups ?? row.top_age_groups),
      audienceGenderSplit: toAudienceGenderSplit(row.audienceGenderSplit ?? row.gender_split),
    };
  });
}

function toAudienceCountries(value: unknown): MarketplaceCreatorPlatform["audienceCountries"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      country: readString(entry.country) ?? "",
      percentage: toNumber(entry.percentage),
    }))
    .filter((entry) => entry.country);
}

function toAudienceAgeGroups(value: unknown): MarketplaceCreatorPlatform["audienceAgeGroups"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      ageRange: readString(entry.ageRange) ?? readString(entry.age_range) ?? "",
      percentage: toNumber(entry.percentage),
    }))
    .filter((entry) => entry.ageRange);
}

function toAudienceGenderSplit(value: unknown): MarketplaceCreatorPlatform["audienceGenderSplit"] {
  if (!value || !isRecord(value) || Object.keys(value).length === 0) return null;
  const other = value.other === undefined ? undefined : toNumber(value.other);
  return {
    male: toNumber(value.male),
    female: toNumber(value.female),
    ...(other !== undefined ? { other } : {}),
  };
}

function parseCount(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return toNumber(value);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
    : [];
}

function toPlatformArray(value: unknown): MarketplacePlatformName[] {
  return toStringArray(value).map(toPlatformName);
}

function toPlatformName(value: string | null | undefined): MarketplacePlatformName {
  switch (value) {
    case "instagram":
    case "tiktok":
    case "youtube":
    case "facebook":
    case "blog":
    case "x":
      return value;
    default:
      return "other";
  }
}

function toCollaborationType(
  value: string | null | undefined,
): MarketplaceOfferingSummary["collaborationType"] {
  switch (value) {
    case "paid":
    case "discount":
    case "affiliate":
      return value;
    default:
      return "free_stay";
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
