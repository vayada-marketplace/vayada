/**
 * Image upload service — uploads files to PMS backend via multipart form data.
 */

const PMS_BASE_URL = process.env.NEXT_PUBLIC_PMS_API_URL || 'http://localhost:8002'

export interface UploadedImage {
  url: string
  thumbnail_url?: string
  key: string
  width: number
  height: number
  size_bytes: number
  format: string
}

export interface MultipleUploadResponse {
  images: UploadedImage[]
  total: number
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('access_token')
}

export const uploadService = {
  async uploadImages(files: File[]): Promise<MultipleUploadResponse> {
    const token = getToken()
    if (!token) throw new Error('Not authenticated')

    const formData = new FormData()
    files.forEach((file) => formData.append('files', file))

    const response = await fetch(`${PMS_BASE_URL}/upload/images`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.detail || `Upload failed (${response.status})`)
    }

    return response.json()
  },
}
