/**
 * Upload API service
 */

import { apiClient, ApiErrorResponse } from './client'

export interface UploadImageResponse {
  url: string
}

export const uploadService = {
  /**
   * Upload an image file
   * @param file - The image file to upload
   * @returns The S3 URL of the uploaded image
   */
  uploadImage: async (file: File): Promise<string> => {
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
      const response = await fetch(`${API_BASE_URL}/upload/image/creator-profile`, {
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
      return data.url
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error
      }
      throw new Error('Failed to upload image')
    }
  },
}

