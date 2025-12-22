/**
 * Users API service for admin
 */

import { apiClient } from './client'
import type { User, UpdateUserRequest } from '@/lib/types'

export interface UsersListResponse {
  users: User[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface UpdateUserStatusRequest {
  status: 'pending' | 'verified' | 'rejected' | 'suspended'
  reason?: string
}

export interface UpdateUserStatusResponse {
  message: string
  user_id: string
  old_status: string
  new_status: string
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
    
    if (params?.type) queryParams.append('type', params.type)
    if (params?.status) queryParams.append('status', params.status)
    if (params?.search) queryParams.append('search', params.search)
    if (params?.page) queryParams.append('page', params.page.toString())
    if (params?.page_size) queryParams.append('page_size', params.page_size.toString())
    
    const queryString = queryParams.toString()
    const endpoint = `/admin/users${queryString ? `?${queryString}` : ''}`
    
    return apiClient.get<UsersListResponse>(endpoint)
  },

  /**
   * Get user by ID
   */
  getUserById: async (userId: string): Promise<User> => {
    return apiClient.get<User>(`/admin/users/${userId}`)
  },

  /**
   * Update user information
   */
  updateUser: async (userId: string, data: UpdateUserRequest): Promise<User> => {
    return apiClient.put<User>(`/admin/users/${userId}`, data)
  },

  /**
   * Update user status (approve/deny/suspend)
   */
  updateUserStatus: async (
    userId: string, 
    status: 'pending' | 'verified' | 'rejected' | 'suspended',
    reason?: string
  ): Promise<UpdateUserStatusResponse> => {
    return apiClient.patch<UpdateUserStatusResponse>(`/admin/users/${userId}/status`, { 
      status,
      ...(reason && { reason })
    })
  },

  /**
   * Delete user
   */
  deleteUser: async (userId: string): Promise<void> => {
    return apiClient.delete<void>(`/admin/users/${userId}`)
  },
}

