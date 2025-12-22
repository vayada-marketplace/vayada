/**
 * Type definitions for the admin frontend
 */

export interface User {
  id: string
  email: string
  name: string
  type: 'hotel' | 'creator' | 'admin'
  status: 'pending' | 'verified' | 'rejected' | 'suspended'
  avatar?: string | null
  email_verified?: boolean
  created_at: string
  updated_at: string
  creator_profile?: CreatorProfile | null
  hotel_profile?: HotelProfile | null
  social_media_platforms?: SocialMediaPlatform[]
  listings?: Listing[]
}

export interface CreatorProfile {
  id?: string
  user_id?: string
  location?: string
  bio?: string
  website?: string
  niche?: string
  follower_count?: number
  platforms?: string[]
  [key: string]: any
}

export interface HotelProfile {
  id?: string
  user_id?: string
  hotel_name?: string
  address?: string
  city?: string
  country?: string
  phone?: string
  website?: string
  star_rating?: number
  [key: string]: any
}

export interface SocialMediaPlatform {
  id: string
  user_id: string
  platform: 'instagram' | 'youtube' | 'tiktok' | 'twitter' | 'facebook' | 'linkedin' | 'other'
  handle?: string
  url?: string
  follower_count?: number
  verified?: boolean
  created_at?: string
  updated_at?: string
}

export interface Listing {
  id: string
  user_id: string
  title: string
  description?: string
  category?: string
  price?: number
  currency?: string
  status?: 'active' | 'inactive' | 'draft' | 'sold'
  images?: string[]
  location?: string
  created_at?: string
  updated_at?: string
  [key: string]: any
}

export interface LoginRequest {
  email: string
  password: string
}

export interface LoginResponse {
  id: string
  email: string
  name: string
  type: string
  status: string
  access_token: string
  token_type: string
  expires_in: number
  message: string
}

export interface CreateUserRequest {
  name: string
  email: string
  password: string
  type: 'hotel' | 'creator' | 'admin'
  status?: 'pending' | 'verified' | 'rejected' | 'suspended'
  creator_profile?: Partial<CreatorProfile>
  hotel_profile?: Partial<HotelProfile>
}

export interface UpdateUserRequest {
  name?: string
  email?: string
  status?: 'pending' | 'verified' | 'rejected' | 'suspended'
  creator_profile?: Partial<CreatorProfile>
  hotel_profile?: Partial<HotelProfile>
}

export interface CreateSocialMediaPlatformRequest {
  platform: SocialMediaPlatform['platform']
  handle?: string
  url?: string
  follower_count?: number
  verified?: boolean
}

export interface UpdateSocialMediaPlatformRequest extends Partial<CreateSocialMediaPlatformRequest> {}

export interface CreateListingRequest {
  title: string
  description?: string
  category?: string
  price?: number
  currency?: string
  status?: Listing['status']
  images?: string[]
  location?: string
}

export interface UpdateListingRequest extends Partial<CreateListingRequest> {}

