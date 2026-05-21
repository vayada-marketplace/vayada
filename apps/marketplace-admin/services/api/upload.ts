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

export interface UploadListingImagesResponse {
  images: UploadImageResponse[]
  total: number
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

  /**
   * Upload multiple image files for listing
   * @param files - Array of image files to upload
   * @param targetUserId - The user ID of the hotel (required for proper organization)
   * @returns The upload response with array of image URLs and metadata
   */
  uploadListingImages: async (files: File[], targetUserId: string): Promise<UploadListingImagesResponse> => {
    const formData = new FormData()
    files.forEach(file => formData.append('files', file))

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
      const response = await fetch(`${API_BASE_URL}/upload/images/listing?target_user_id=${targetUserId}`, {
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

      const data: UploadListingImagesResponse = await response.json()
      return data
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error
      }
      throw new Error('Failed to upload listing images')
    }
  },

  /**
   * Upload an image file for hotel profile
   * @param file - The image file to upload
   * @param targetUserId - The user ID of the hotel (required for proper organization)
   * @returns The upload response with URL and metadata
   */
  uploadHotelProfileImage: async (file: File, targetUserId: string): Promise<UploadImageResponse> => {
    const formData = new FormData()
    formData.append('files', file)

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
      const response = await fetch(`${API_BASE_URL}/upload/images?target_user_id=${targetUserId}&prefix=hotels`, {
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

      const data: UploadListingImagesResponse = await response.json()
      // Return the first image from the response
      if (data.images && data.images.length > 0) {
        return data.images[0]
      }
      throw new Error('No image returned from upload')
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error
      }
      throw new Error('Failed to upload hotel profile image')
    }
  },
}

