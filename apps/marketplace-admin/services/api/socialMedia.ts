/**
 * Social Media Platforms API service for admin
 */

import { apiClient } from './client'
import type { SocialMediaPlatform, CreateSocialMediaPlatformRequest, UpdateSocialMediaPlatformRequest } from '@/lib/types'

export const socialMediaService = {
  /**
   * Get all social media platforms for a user
   */
  getUserPlatforms: async (userId: string): Promise<SocialMediaPlatform[]> => {
    return apiClient.get<SocialMediaPlatform[]>(`/admin/users/${userId}/social-media`)
  },

  /**
   * Get a specific social media platform
   */
  getPlatformById: async (userId: string, platformId: string): Promise<SocialMediaPlatform> => {
    return apiClient.get<SocialMediaPlatform>(`/admin/users/${userId}/social-media/${platformId}`)
  },

  /**
   * Create a new social media platform for a user
   */
  createPlatform: async (userId: string, data: CreateSocialMediaPlatformRequest): Promise<SocialMediaPlatform> => {
    return apiClient.post<SocialMediaPlatform>(`/admin/users/${userId}/social-media`, data)
  },

  /**
   * Update a social media platform
   */
  updatePlatform: async (
    userId: string,
    platformId: string,
    data: UpdateSocialMediaPlatformRequest
  ): Promise<SocialMediaPlatform> => {
    return apiClient.put<SocialMediaPlatform>(`/admin/users/${userId}/social-media/${platformId}`, data)
  },

  /**
   * Delete a social media platform
   */
  deletePlatform: async (userId: string, platformId: string): Promise<void> => {
    return apiClient.delete<void>(`/admin/users/${userId}/social-media/${platformId}`)
  },
}

