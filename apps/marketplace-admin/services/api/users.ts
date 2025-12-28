/**
 * Users API service for admin
 */

import { apiClient } from './client'
import type { User, UserDetailResponse, CreateUserRequest } from '@/lib/types'

export interface UsersListResponse {
  users: User[]
  total: number
}

/**
 * Transform snake_case to camelCase for nested objects
 */
function transformSnakeToCamel(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) {
    return obj.map(item => transformSnakeToCamel(item))
  }
  if (typeof obj !== 'object') return obj
  
  const transformed: any = {}
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    transformed[camelKey] = transformSnakeToCamel(value)
  }
  return transformed
}

export const usersService = {
  /**
   * Get all users (with optional filters and pagination)
   */
  getAllUsers: async (params?: {
    type?: 'hotel' | 'creator' | 'admin'
    status?: 'pending' | 'verified' | 'rejected' | 'suspended'
    search?: string
    page?: number
    page_size?: number
  }): Promise<UsersListResponse> => {
    const queryParams = new URLSearchParams()
    
    // Add query parameters if provided
    if (params?.page) queryParams.append('page', params.page.toString())
    if (params?.page_size) queryParams.append('page_size', params.page_size.toString())
    if (params?.type) queryParams.append('type', params.type)
    if (params?.status) queryParams.append('status', params.status)
    if (params?.search) queryParams.append('search', params.search)
    
    const queryString = queryParams.toString()
    const endpoint = `/admin/users${queryString ? `?${queryString}` : ''}`
    
    return apiClient.get<UsersListResponse>(endpoint)
  },

  /**
   * Get user by ID with full details (profile, platforms, listings)
   */
  getUserById: async (userId: string): Promise<UserDetailResponse> => {
    const response = await apiClient.get<any>(`/admin/users/${userId}`)
    // Transform snake_case to camelCase to match TypeScript interfaces
    return transformSnakeToCamel(response) as UserDetailResponse
  },

  /**
   * Create a new user (creator or hotel)
   */
  createUser: async (data: CreateUserRequest): Promise<User> => {
    const response = await apiClient.post<any>('/admin/users', data)
    return transformSnakeToCamel(response) as User
  },

  /**
   * Update user account fields (status, emailVerified, email, name, etc.)
   */
  updateUser: async (userId: string, data: {
    status?: 'pending' | 'verified' | 'rejected' | 'suspended'
    emailVerified?: boolean
    email?: string
    name?: string
  }): Promise<any> => {
    const response = await apiClient.put<any>(`/admin/users/${userId}`, data)
    return transformSnakeToCamel(response)
  },

  /**
   * Update creator profile
   */
  updateCreatorProfile: async (userId: string, data: {
    name?: string
    profilePicture?: string
    location?: string
    shortDescription?: string
    portfolioLink?: string
    phone?: string
    platforms?: Array<{
      name: 'Instagram' | 'TikTok' | 'YouTube' | 'Facebook'
      handle: string
      followers: number
      engagementRate: number
      topCountries?: Array<{country: string, percentage: number}>
      topAgeGroups?: Array<{ageRange: string, percentage: number}>
      genderSplit?: {male: number, female: number, other?: number}
    }>
  }): Promise<any> => {
    const response = await apiClient.put<any>(`/admin/users/${userId}/profile/creator`, data)
    return transformSnakeToCamel(response)
  },

  /**
   * Update hotel profile
   */
  updateHotelProfile: async (userId: string, data: {
    name?: string
    location?: string
    email?: string
    about?: string
    website?: string
    phone?: string
    picture?: string
  }): Promise<any> => {
    const response = await apiClient.put<any>(`/admin/users/${userId}/profile/hotel`, data)
    return transformSnakeToCamel(response)
  },

  /**
   * Create a listing for a hotel user
   */
  createListing: async (hotelUserId: string, data: {
    name: string
    location: string
    description: string
    accommodationType?: string
    images?: string[]
    collaborationOfferings?: any[]
    creatorRequirements?: any
  }): Promise<any> => {
    const response = await apiClient.post<any>(`/admin/users/${hotelUserId}/listings`, data)
    return transformSnakeToCamel(response)
  },

  /**
   * Update a listing
   */
  updateListing: async (hotelUserId: string, listingId: string, data: {
    name?: string
    location?: string
    description?: string
    accommodationType?: string
    images?: string[]
    collaborationOfferings?: any[]
    creatorRequirements?: any
  }): Promise<any> => {
    const response = await apiClient.put<any>(`/admin/users/${hotelUserId}/listings/${listingId}`, data)
    return transformSnakeToCamel(response)
  },

  /**
   * Delete a listing
   * ⚠️ Warning: This action cannot be undone!
   * Permanently removes the listing, all collaboration offerings, creator requirements, and all images from S3.
   */
  deleteListing: async (hotelUserId: string, listingId: string): Promise<{
    message: string
    deletedListing: {
      id: string
      name: string
    }
    imagesDeleted: number
    imagesFailed: number
  }> => {
    const response = await apiClient.delete<any>(`/admin/users/${hotelUserId}/listings/${listingId}`)
    return transformSnakeToCamel(response)
  },

  /**
   * Delete a user permanently
   * ⚠️ Warning: This action cannot be undone!
   */
  deleteUser: async (userId: string): Promise<{ message: string; deleted_user: User }> => {
    const response = await apiClient.delete<any>(`/admin/users/${userId}`)
    return transformSnakeToCamel(response)
  },
}
