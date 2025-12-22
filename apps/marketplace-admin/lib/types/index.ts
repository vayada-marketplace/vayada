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
}

export interface CreatorProfile {
  location?: string
  platforms?: string[]
  [key: string]: any
}

export interface HotelProfile {
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

export interface UpdateUserRequest {
  name?: string
  email?: string
  status?: 'pending' | 'verified' | 'rejected' | 'suspended'
}

