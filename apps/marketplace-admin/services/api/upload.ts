/**
 * Upload API service
 */

import { apiClient, ApiErrorResponse } from './client'

export interface UploadImageResponse {
  url: string
  thumbnail_url?: string
  key?: string
  width?: number
  height?: number
  size_bytes?: number
  format?: string
}

export const uploadService = {
  /**
   * Upload an image file for creator profile
   * @param file - The image file to upload
   * @param targetUserId - The user ID of the creator (required for proper organization)
   * @returns The upload response with URL and metadata
   */
  uploadCreatorProfileImage: async (file: File, targetUserId: string): Promise<UploadImageResponse> => {
    const formData = new FormData()
    formData.append('file', file)

    const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
    
    // Get token using the same method as apiClient
    let token: string | null = null
    if (typeof window !== 'undefined') {
      const storedToken = localStorage.getItem('access_token')
      const expiresAt = localStorage.getItem('token_expires_at')
      if (storedToken && expiresAt && Date.now() < parseInt(expiresAt)) {
        token = storedToken
      }
    }

    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    // Don't set Content-Type for FormData - browser will set it with boundary

    try {
      const response = await fetch(`${API_BASE_URL}/upload/image/creator-profile?target_user_id=${targetUserId}`, {
        method: 'POST',
        headers,
        body: formData,
      })

      if (!response.ok) {
        const contentType = response.headers.get('content-type')
        const hasJsonContent = contentType && contentType.includes('application/json')
        
        let errorData: any
        if (hasJsonContent) {
          errorData = await response.json()
        } else {
          errorData = { detail: await response.text() || 'Upload failed' }
        }

        throw new ApiErrorResponse(response.status, errorData)
      }

      const data: UploadImageResponse = await response.json()
      return data
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error
      }
      throw new Error('Failed to upload image')
    }
  },
}

