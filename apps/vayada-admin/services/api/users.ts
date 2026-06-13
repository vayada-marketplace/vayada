/**
 * Users API service for admin
 */

import { apiClient } from "./client";
import {
  createMarketplaceAdminHotelListing,
  deleteMarketplaceAdminHotelListing,
  updateMarketplaceAdminHotelListing,
  type MarketplaceAdminCreateHotelListingRequest,
  type MarketplaceAdminUpdateHotelListingRequest,
  type MarketplaceHotelListingCreatorRequirementsWrite,
  type MarketplaceHotelListingOfferingWrite,
} from "@vayada/marketplace-shared/api/admin";
import type { User, UserDetailResponse, CreateUserRequest } from "@/lib/types";

export interface UsersListResponse {
  users: User[];
  total: number;
}

export interface IdentityCommandResponse {
  userId: string;
  status: "accepted" | "idempotent_replay";
  commands: Array<{
    commandType: string;
    commandId: string;
    idempotencyKey: string;
    status: "accepted" | "idempotent_replay";
  }>;
}

/**
 * Transform snake_case to camelCase for nested objects
 */
function transformSnakeToCamel(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => transformSnakeToCamel(item));
  }
  if (typeof obj !== "object") return obj;

  const transformed: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    transformed[camelKey] = transformSnakeToCamel(value);
  }
  return transformed;
}

export const usersService = {
  /**
   * Get all users (with optional filters and pagination)
   */
  getAllUsers: async (params?: {
    type?: "hotel" | "creator" | "admin";
    status?: "pending" | "verified" | "rejected" | "suspended";
    search?: string;
    page?: number;
    page_size?: number;
  }): Promise<UsersListResponse> => {
    const queryParams = new URLSearchParams();

    // Add query parameters if provided
    if (params?.page) queryParams.append("page", params.page.toString());
    if (params?.page_size) queryParams.append("page_size", params.page_size.toString());
    if (params?.type) queryParams.append("type", params.type);
    if (params?.status) queryParams.append("status", params.status);
    if (params?.search) queryParams.append("search", params.search);

    const queryString = queryParams.toString();
    const endpoint = `/api/identity/admin/users${queryString ? `?${queryString}` : ""}`;

    return apiClient.get<UsersListResponse>(endpoint);
  },

  /**
   * Get user by ID with full details (profile, platforms, listings)
   */
  getUserById: async (userId: string): Promise<UserDetailResponse> => {
    const response = await apiClient.get<any>(`/api/identity/admin/users/${userId}`);
    // Transform snake_case to camelCase to match TypeScript interfaces
    return transformSnakeToCamel(response) as UserDetailResponse;
  },

  /**
   * Create a new identity user. Product profile writes stay on the legacy
   * marketplace admin route until their owning marketplace vertical migrates.
   */
  createUser: async (data: CreateUserRequest): Promise<User> => {
    const response = await apiClient.post<IdentityCommandResponse>("/api/identity/admin/users", {
      email: data.email,
      name: data.name,
      type: data.type,
      status: data.status,
      emailVerified: data.emailVerified,
    });
    return {
      id: response.userId,
      email: data.email,
      name: data.name,
      type: data.type,
      status: data.status ?? "pending",
      email_verified: data.emailVerified,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  },

  /**
   * Update user account fields (status, emailVerified, email, name, etc.)
   */
  updateUser: async (
    userId: string,
    data: {
      status?: "pending" | "verified" | "rejected" | "suspended";
      emailVerified?: boolean;
      email?: string;
      name?: string;
    },
  ): Promise<any> => {
    const response = await apiClient.patch<any>(`/api/identity/admin/users/${userId}`, data);
    return transformSnakeToCamel(response);
  },

  /**
   * Update creator profile
   */
  updateCreatorProfile: async (
    userId: string,
    data: {
      name?: string;
      profilePicture?: string;
      location?: string;
      shortDescription?: string;
      portfolioLink?: string;
      phone?: string;
      platforms?: Array<{
        name: "Instagram" | "TikTok" | "YouTube" | "Facebook";
        handle: string;
        followers: number;
        engagementRate: number;
        topCountries?: Array<{ country: string; percentage: number }>;
        topAgeGroups?: Array<{ ageRange: string; percentage: number }>;
        genderSplit?: { male: number; female: number; other?: number };
      }>;
    },
  ): Promise<any> => {
    const response = await apiClient.put<any>(`/admin/users/${userId}/profile/creator`, data);
    return transformSnakeToCamel(response);
  },

  /**
   * Update hotel profile
   */
  updateHotelProfile: async (
    userId: string,
    data: {
      name?: string;
      location?: string;
      email?: string;
      about?: string;
      website?: string;
      phone?: string;
      picture?: string;
    },
  ): Promise<any> => {
    const response = await apiClient.put<any>(`/admin/users/${userId}/profile/hotel`, data);
    return transformSnakeToCamel(response);
  },

  /**
   * Create a listing for a hotel user
   */
  createListing: async (
    hotelUserId: string,
    data: {
      name: string;
      location: string;
      description: string;
      accommodationType?: string;
      images?: string[];
      collaborationOfferings?: any[];
      creatorRequirements?: any;
    },
  ): Promise<any> => {
    const response = await createMarketplaceAdminHotelListing(
      hotelUserId,
      toMarketplaceAdminCreateListingRequest(data),
    );
    return transformSnakeToCamel(response);
  },

  /**
   * Update a listing
   */
  updateListing: async (
    hotelUserId: string,
    listingId: string,
    data: {
      name?: string;
      location?: string;
      description?: string;
      accommodationType?: string;
      images?: string[];
      collaborationOfferings?: any[];
      creatorRequirements?: any;
    },
  ): Promise<any> => {
    const response = await updateMarketplaceAdminHotelListing(
      hotelUserId,
      listingId,
      toMarketplaceAdminUpdateListingRequest(data),
    );
    return transformSnakeToCamel(response);
  },

  /**
   * Delete a listing
   * ⚠️ Warning: This action cannot be undone!
   * Permanently removes the listing, all collaboration offerings, creator requirements, and all images from S3.
   */
  deleteListing: async (
    hotelUserId: string,
    listingId: string,
  ): Promise<{
    message: string;
    deletedListing: {
      id: string;
      name: string;
    };
    imagesDeleted: number;
    imagesFailed: number;
  }> => {
    const response = await deleteMarketplaceAdminHotelListing(hotelUserId, listingId);
    return {
      message: "Listing archived.",
      deletedListing: {
        id: response.deletedListing.listingId,
        name: response.deletedListing.title,
      },
      imagesDeleted: 0,
      imagesFailed: 0,
    };
  },

  /**
   * Soft-delete an identity user through the identity lifecycle command bus.
   */
  deleteUser: async (userId: string): Promise<{ message: string; deleted_user: User }> => {
    const response = await apiClient.delete<IdentityCommandResponse>(
      `/api/identity/admin/users/${userId}`,
    );
    return {
      message: "Identity user deletion command accepted.",
      deleted_user: {
        id: response.userId,
        email: "",
        name: "",
        type: "admin",
        status: "suspended",
        created_at: "",
        updated_at: "",
      },
    };
  },

  setPlatformAccess: async (userId: string, enabled: boolean): Promise<IdentityCommandResponse> => {
    return apiClient.put<IdentityCommandResponse>(
      `/api/identity/admin/users/${userId}/platform-access`,
      { enabled },
    );
  },
};

function toMarketplaceAdminCreateListingRequest(data: {
  name: string;
  location: string;
  description: string;
  accommodationType?: string;
  images?: string[];
  collaborationOfferings?: any[];
  creatorRequirements?: any;
}): MarketplaceAdminCreateHotelListingRequest {
  return {
    title: data.name,
    listingSummary: data.description,
    accommodationType: toMarketplaceAccommodationType(data.accommodationType),
    rawLocationText: data.location,
    imageUrls: data.images ?? [],
    collaborationOfferings: toMarketplaceOfferings(data.collaborationOfferings),
    creatorRequirements: toMarketplaceCreatorRequirements(data.creatorRequirements),
  };
}

function toMarketplaceAdminUpdateListingRequest(data: {
  name?: string;
  location?: string;
  description?: string;
  accommodationType?: string;
  images?: string[];
  collaborationOfferings?: any[];
  creatorRequirements?: any;
}): MarketplaceAdminUpdateHotelListingRequest {
  return {
    ...(data.name !== undefined ? { title: data.name } : {}),
    ...(data.description !== undefined ? { listingSummary: data.description } : {}),
    ...(data.accommodationType !== undefined
      ? { accommodationType: toMarketplaceAccommodationType(data.accommodationType) }
      : {}),
    ...(data.location !== undefined ? { rawLocationText: data.location } : {}),
    ...(data.images !== undefined ? { imageUrls: data.images } : {}),
    ...(data.collaborationOfferings !== undefined
      ? { collaborationOfferings: toMarketplaceOfferings(data.collaborationOfferings) }
      : {}),
    ...(data.creatorRequirements !== undefined
      ? { creatorRequirements: toMarketplaceCreatorRequirements(data.creatorRequirements) }
      : {}),
  };
}

function toMarketplaceOfferings(
  offerings: any[] | undefined,
): MarketplaceHotelListingOfferingWrite[] {
  return (offerings ?? []).map((offering) => ({
    collaborationType: toMarketplaceCollaborationType(offering.collaborationType),
    availabilityMonths: offering.availabilityMonths ?? [],
    platforms: (offering.platforms ?? []).map(toMarketplacePlatform),
    freeStayMinNights: toNullableNumber(offering.freeStayMinNights),
    freeStayMaxNights: toNullableNumber(offering.freeStayMaxNights),
    paidMaxAmount:
      offering.paidMaxAmount === null || offering.paidMaxAmount === undefined
        ? null
        : String(offering.paidMaxAmount),
    discountPercentage: toNullableNumber(offering.discountPercentage),
    commissionPercentage: toNullableNumber(offering.commissionPercentage),
    minFollowers: toNullableNumber(offering.minFollowers),
    currency: offering.currency ?? null,
    termsSummary: offering.termsSummary ?? null,
  }));
}

function toMarketplaceCreatorRequirements(
  requirements: any,
): MarketplaceHotelListingCreatorRequirementsWrite {
  return {
    platforms: (requirements?.platforms ?? []).map(toMarketplacePlatform),
    targetCountries: requirements?.targetCountries ?? [],
    targetAgeMin: toNullableNumber(requirements?.targetAgeMin),
    targetAgeMax: toNullableNumber(requirements?.targetAgeMax),
    targetAgeGroups: requirements?.targetAgeGroups ?? [],
    creatorTypes: requirements?.creatorTypes ?? [],
  };
}

function toMarketplaceCollaborationType(
  value: string | undefined,
): MarketplaceHotelListingOfferingWrite["collaborationType"] {
  switch (value) {
    case "Paid":
      return "paid";
    case "Discount":
      return "discount";
    case "Affiliate":
      return "affiliate";
    case "Free Stay":
    default:
      return "free_stay";
  }
}

function toMarketplacePlatform(
  value: string,
): "instagram" | "tiktok" | "youtube" | "facebook" | "blog" | "x" | "other" {
  switch (value) {
    case "Instagram":
      return "instagram";
    case "TikTok":
      return "tiktok";
    case "YouTube":
      return "youtube";
    case "Facebook":
      return "facebook";
    case "Blog":
      return "blog";
    case "X":
      return "x";
    default:
      return "other";
  }
}

function toMarketplaceAccommodationType(
  value: string | undefined,
): "hotel" | "resort" | "boutique_hotel" | "lodge" | "apartment" | "villa" | "other" | null {
  switch (value) {
    case "Hotel":
    case "City Hotel":
    case "Luxury Hotel":
      return "hotel";
    case "Boutiques Hotel":
      return "boutique_hotel";
    case "Apartment":
      return "apartment";
    case "Villa":
      return "villa";
    case "Lodge":
      return "lodge";
    default:
      return value ? "other" : null;
  }
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
