/**
 * Users API service for admin
 */

import { apiClient } from './client'
import type { User, UserDetailResponse } from '@/lib/types'

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
}
