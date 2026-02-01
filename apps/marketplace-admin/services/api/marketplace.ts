/**
 * Marketplace API service - fetches public marketplace data
 */
import { apiClient } from './client'

export interface MarketplaceListing {
  id: string
  hotel_profile_id: string
  hotel_name: string
  hotel_picture: string | null
  name: string
  location: string
  description: string
  accommodation_type: string | null
  images: string[]
  status: string
  collaboration_offerings: CollaborationOffering[]
  creator_requirements: CreatorRequirements | null
  created_at: string
}

export interface CollaborationOffering {
  id: string
  listing_id: string
  collaboration_type: 'Free Stay' | 'Paid' | 'Discount'
  availability_months: string[]
  platforms: string[]
  free_stay_min_nights: number | null
  free_stay_max_nights: number | null
  paid_max_amount: number | null
  discount_percentage: number | null
  created_at: string
  updated_at: string
}

export interface CreatorRequirements {
  id: string
  listing_id: string
  platforms: string[]
  min_followers: number | null
  target_countries: string[]
  target_age_min: number | null
  target_age_max: number | null
  target_age_groups: string[] | null
  created_at: string
  updated_at: string
}

export interface MarketplaceCreator {
  id: string
  name: string
  location: string
  short_description: string
  portfolio_link: string | null
  profile_picture: string | null
  platforms: CreatorPlatform[]
  audience_size: number
  average_rating: number
  total_reviews: number
  created_at: string
}

export interface CreatorPlatform {
  id: string
  name: string
  handle: string
  followers: number
  engagement_rate: number
  top_countries: { country: string; percentage: number }[] | null
  top_age_groups: { ageRange: string; percentage: number }[] | null
  gender_split: { male: number; female: number } | null
}

export const marketplaceService = {
  /**
   * Get all marketplace listings (public endpoint)
   */
  getListings: async (): Promise<MarketplaceListing[]> => {
    return apiClient.get<MarketplaceListing[]>('/marketplace/listings')
  },

  /**
   * Get all marketplace creators (public endpoint)
   */
  getCreators: async (): Promise<MarketplaceCreator[]> => {
    return apiClient.get<MarketplaceCreator[]>('/marketplace/creators')
  },
}
