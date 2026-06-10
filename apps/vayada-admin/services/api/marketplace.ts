/**
 * Marketplace API service - fetches public marketplace data
 */
import { ApiErrorResponse } from "./client";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.vayada.com";

export interface MarketplaceListing {
  id: string;
  hotel_profile_id: string;
  hotel_name: string;
  hotel_picture: string | null;
  owner_email: string | null;
  owner_user_id: string | null;
  name: string;
  location: string;
  description: string;
  accommodation_type: string | null;
  images: string[];
  status: string;
  collaboration_offerings: CollaborationOffering[];
  creator_requirements: CreatorRequirements | null;
  created_at: string;
}

type MarketplacePlatformName =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "blog"
  | "x"
  | "other";

type MarketplaceOfferingSummary = {
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

type MarketplaceListingReadModel = {
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
  creatorRequirements: {
    platforms: MarketplacePlatformName[];
    targetCountries: string[];
    targetAgeMin: number | null;
    targetAgeMax: number | null;
    targetAgeGroups: string[] | null;
  } | null;
  createdAt: string;
  projectedAt: string;
};

type MarketplaceCreatorReadModel = {
  creatorId: string;
  displayName: string;
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  profilePictureUrl: string | null;
  creatorType: "lifestyle" | "travel" | "other";
  platforms: {
    platformId: string;
    platform: MarketplacePlatformName;
    handle: string;
    followerCount: number;
    engagementRate: number;
    audienceCountries: { country: string; percentage: number }[];
    audienceAgeGroups: { ageRange: string; percentage: number }[];
    audienceGenderSplit: { male: number; female: number; other?: number } | null;
  }[];
  audienceSize: number;
  averageRating: number;
  totalReviews: number;
  createdAt: string;
};

type MarketplaceDiscoveryPage<T> = {
  items: T[];
  pagination: { limit: number; offset: number; total: number };
};

export interface CollaborationOffering {
  id: string;
  listing_id: string;
  collaboration_type: "Free Stay" | "Paid" | "Discount" | "Affiliate";
  availability_months: string[];
  platforms: string[];
  free_stay_min_nights: number | null;
  free_stay_max_nights: number | null;
  paid_max_amount: number | null;
  currency: string | null;
  discount_percentage: number | null;
  commission_percentage: number | null;
  min_followers?: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreatorRequirements {
  id: string;
  listing_id: string;
  platforms: string[];
  target_countries: string[];
  target_age_min: number | null;
  target_age_max: number | null;
  target_age_groups: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceCreator {
  id: string;
  name: string;
  location: string;
  short_description: string;
  portfolio_link: string | null;
  profile_picture: string | null;
  platforms: CreatorPlatform[];
  audience_size: number;
  average_rating: number;
  total_reviews: number;
  created_at: string;
}

export interface CreatorPlatform {
  id: string;
  name: string;
  handle: string;
  followers: number;
  engagement_rate: number;
  top_countries: { country: string; percentage: number }[] | null;
  top_age_groups: { ageRange: string; percentage: number }[] | null;
  gender_split: { male: number; female: number } | null;
}

export const marketplaceService = {
  /**
   * Get all marketplace listings (public endpoint)
   */
  getListings: async (): Promise<MarketplaceListing[]> => {
    const listings = await getAllMarketplaceDiscoveryItems<MarketplaceListingReadModel>(
      "/api/marketplace/listings",
    );
    return listings.map(toMarketplaceListing);
  },

  /**
   * Get all marketplace creators (public endpoint)
   */
  getCreators: async (): Promise<MarketplaceCreator[]> => {
    const creators = await getAllMarketplaceDiscoveryItems<MarketplaceCreatorReadModel>(
      "/api/marketplace/creators",
    );
    return creators.map(toMarketplaceCreator);
  },
};

async function getAllMarketplaceDiscoveryItems<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  const limit = 200;

  while (offset < total) {
    const separator = path.includes("?") ? "&" : "?";
    const page = await requestMarketplaceDiscovery<MarketplaceDiscoveryPage<T>>(
      `${path}${separator}limit=${limit}&offset=${offset}`,
    );
    items.push(...page.items);
    total = page.pagination.total;
    offset += page.pagination.limit;
    if (page.items.length === 0) break;
  }

  return items;
}

async function requestMarketplaceDiscovery<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
  });

  const contentType = response.headers.get("content-type");
  const body = contentType?.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String(body.message)
        : `Marketplace discovery request failed: ${response.status}`;
    throw new ApiErrorResponse(response.status, { detail: message });
  }

  return body as T;
}

function toMarketplaceListing(listing: MarketplaceListingReadModel): MarketplaceListing {
  return {
    id: listing.listingId,
    hotel_profile_id: listing.publicId,
    hotel_name: listing.displayName,
    hotel_picture: listing.coverImageUrl,
    owner_email: null,
    owner_user_id: null,
    name: listing.listingTitle,
    location: listing.location.displayText,
    description: listing.listingSummary ?? "",
    accommodation_type: listing.accommodationType,
    images: listing.imageUrls,
    status: "verified",
    collaboration_offerings: listing.offerings.map((offering) => ({
      id: offering.offeringId,
      listing_id: listing.listingId,
      collaboration_type: toLegacyCollaborationType(offering.collaborationType),
      availability_months: offering.availabilityMonths,
      platforms: offering.platforms.map(toLegacyPlatformName),
      free_stay_min_nights: offering.freeStayMinNights,
      free_stay_max_nights: offering.freeStayMaxNights,
      paid_max_amount: offering.paidMaxAmount === null ? null : Number(offering.paidMaxAmount),
      currency: offering.currency,
      discount_percentage: offering.discountPercentage,
      commission_percentage: offering.commissionPercentage,
      min_followers: offering.minFollowers,
      created_at: listing.createdAt,
      updated_at: listing.projectedAt,
    })),
    creator_requirements: listing.creatorRequirements
      ? {
          id: `${listing.listingId}:requirements`,
          listing_id: listing.listingId,
          platforms: listing.creatorRequirements.platforms.map(toLegacyPlatformName),
          target_countries: listing.creatorRequirements.targetCountries,
          target_age_min: listing.creatorRequirements.targetAgeMin,
          target_age_max: listing.creatorRequirements.targetAgeMax,
          target_age_groups: listing.creatorRequirements.targetAgeGroups,
          created_at: listing.createdAt,
          updated_at: listing.projectedAt,
        }
      : null,
    created_at: listing.createdAt,
  };
}

function toMarketplaceCreator(creator: MarketplaceCreatorReadModel): MarketplaceCreator {
  return {
    id: creator.creatorId,
    name: creator.displayName,
    location: creator.locationText ?? "",
    short_description: creator.shortDescription ?? "",
    portfolio_link: creator.portfolioUrl,
    profile_picture: creator.profilePictureUrl,
    platforms: creator.platforms.map((platform) => ({
      id: platform.platformId,
      name: toLegacyPlatformName(platform.platform),
      handle: platform.handle,
      followers: platform.followerCount,
      engagement_rate: platform.engagementRate,
      top_countries: platform.audienceCountries,
      top_age_groups: platform.audienceAgeGroups,
      gender_split: platform.audienceGenderSplit,
    })),
    audience_size: creator.audienceSize,
    average_rating: creator.averageRating,
    total_reviews: creator.totalReviews,
    created_at: creator.createdAt,
  };
}

function toLegacyCollaborationType(
  type: MarketplaceOfferingSummary["collaborationType"],
): "Free Stay" | "Paid" | "Discount" | "Affiliate" {
  switch (type) {
    case "paid":
      return "Paid";
    case "discount":
      return "Discount";
    case "affiliate":
      return "Affiliate";
    case "free_stay":
      return "Free Stay";
  }
}

function toLegacyPlatformName(platform: MarketplacePlatformName): string {
  switch (platform) {
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "youtube":
      return "YouTube";
    case "facebook":
      return "Facebook";
    case "blog":
      return "Blog";
    case "x":
      return "X";
    case "other":
      return "Other";
  }
}
