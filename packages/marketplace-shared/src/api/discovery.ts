import { ApiErrorResponse } from "./client";

const MARKETPLACE_DISCOVERY_API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://api.marketplace.localhost";

export const marketplaceDiscoveryEndpoints = {
  listings: (input: MarketplaceDiscoveryPageInput = {}) =>
    `/api/marketplace/listings${toPageQuery(input)}`,
  creators: (input: MarketplaceDiscoveryPageInput = {}) =>
    `/api/marketplace/creators${toPageQuery(input)}`,
} as const;

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

export type MarketplaceDiscoveryPageInput = {
  limit?: number;
  offset?: number;
};

export type MarketplaceDiscoveryErrorBody = {
  statusCode: 400 | 500;
  code: "invalid_query" | "internal_error";
  category: "validation" | "internal";
  message: string;
};

export class MarketplaceDiscoveryClientError extends Error {
  status: number;
  body: MarketplaceDiscoveryErrorBody | string | null;

  constructor(status: number, body: MarketplaceDiscoveryErrorBody | string | null) {
    super(readMarketplaceDiscoveryErrorMessage(status, body));
    this.name = "MarketplaceDiscoveryClientError";
    this.status = status;
    this.body = body;
  }
}

export async function getMarketplaceListings(
  input: MarketplaceDiscoveryPageInput = {},
): Promise<MarketplaceListingPage> {
  return requestMarketplaceDiscovery<MarketplaceListingPage>(
    marketplaceDiscoveryEndpoints.listings(input),
  );
}

export async function getMarketplaceCreators(
  input: MarketplaceDiscoveryPageInput = {},
): Promise<MarketplaceCreatorPage> {
  return requestMarketplaceDiscovery<MarketplaceCreatorPage>(
    marketplaceDiscoveryEndpoints.creators(input),
  );
}

export async function getAllMarketplaceListings(
  input: { pageSize?: number } = {},
): Promise<MarketplaceListingReadModel[]> {
  return collectMarketplaceDiscoveryPages(input.pageSize, getMarketplaceListings);
}

export async function getAllMarketplaceCreators(
  input: { pageSize?: number } = {},
): Promise<MarketplaceCreatorReadModel[]> {
  return collectMarketplaceDiscoveryPages(input.pageSize, getMarketplaceCreators);
}

async function collectMarketplaceDiscoveryPages<T>(
  pageSize = 200,
  fetchPage: (input: MarketplaceDiscoveryPageInput) => Promise<{
    items: T[];
    pagination: MarketplaceDiscoveryPagination;
  }>,
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const page = await fetchPage({ limit: pageSize, offset });
    items.push(...page.items);
    total = page.pagination.total;
    offset += page.pagination.limit;

    if (page.items.length === 0) break;
  }

  return items;
}

async function requestMarketplaceDiscovery<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${MARKETPLACE_DISCOVERY_API_BASE_URL}${endpoint}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
  });

  const contentType = response.headers.get("content-type");
  const hasJsonContent = contentType?.includes("application/json");
  const body = hasJsonContent ? await response.json() : await response.text();

  if (!response.ok) {
    throw new ApiErrorResponse(response.status, {
      detail: readMarketplaceDiscoveryErrorMessage(response.status, body),
    });
  }

  return body as T;
}

function toPageQuery(input: MarketplaceDiscoveryPageInput): string {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.offset !== undefined) params.set("offset", String(input.offset));
  const query = params.toString();
  return query ? `?${query}` : "";
}

function readMarketplaceDiscoveryErrorMessage(
  status: number,
  body: MarketplaceDiscoveryErrorBody | string | null,
): string {
  if (body && typeof body === "object" && "message" in body) {
    return body.message;
  }
  if (typeof body === "string" && body) return body;
  return `Marketplace discovery request failed: ${status}`;
}
