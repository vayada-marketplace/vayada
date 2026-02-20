/**
 * API client configuration
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || 'http://localhost:8001'

export interface ApiError {
  detail: string | Array<{
    loc: (string | number)[]
    msg: string
    type: string
  }>
}

export class ApiErrorResponse extends Error {
  status: number
  data: ApiError

  constructor(status: number, data: ApiError) {
    super(data.detail as string || `API Error: ${status}`)
    this.name = 'ApiErrorResponse'
    this.status = status
    this.data = data
  }
}

export class ApiClient {
  private baseURL: string
  private TOKEN_KEY = 'access_token'
  private EXPIRES_AT_KEY = 'token_expires_at'

  constructor(baseURL: string = API_BASE_URL) {
    this.baseURL = baseURL
  }

  private getToken(): string | null {
    if (typeof window === 'undefined') return null

    const token = localStorage.getItem(this.TOKEN_KEY)
    const expiresAt = localStorage.getItem(this.EXPIRES_AT_KEY)

    if (!token || !expiresAt) return null

    if (Date.now() >= parseInt(expiresAt)) {
      this.clearToken()
      return null
    }

    return token
  }

  private clearToken(): void {
    if (typeof window === 'undefined') return
    localStorage.removeItem(this.TOKEN_KEY)
    localStorage.removeItem(this.EXPIRES_AT_KEY)
  }

  private handleUnauthorized(error: ApiErrorResponse): void {
    this.clearToken()

    if (typeof window !== 'undefined') {
      const errorMessage = error.data.detail as string || ''
      const isExpired = errorMessage.includes('expired') || errorMessage.includes('Expired')

      if (isExpired) {
        window.location.href = '/login?expired=true'
      } else {
        window.location.href = '/login'
      }
    }
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`

    const token = !endpoint.startsWith('/auth/') ? this.getToken() : null

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const config: RequestInit = {
      ...options,
      headers,
    }

    try {
      const response = await fetch(url, config)

      if (response.status === 204) {
        if (!response.ok) {
          throw new ApiErrorResponse(response.status, { detail: 'No Content' })
        }
        return undefined as T
      }

      const contentType = response.headers.get('content-type')
      const hasJsonContent = contentType && contentType.includes('application/json')

      let data: any
      if (hasJsonContent) {
        const text = await response.text()
        data = text ? JSON.parse(text) : null
      } else {
        const text = await response.text()
        data = text || null
      }

      if (!response.ok) {
        const error = new ApiErrorResponse(response.status, data as ApiError)

        if (response.status === 401 && !endpoint.startsWith('/auth/')) {
          this.handleUnauthorized(error)
        }

        throw error
      }

      return data as T
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error
      }
      if (error instanceof SyntaxError && error.message.includes('JSON')) {
        return undefined as T
      }
      console.error('API request failed:', error)
      throw error
    }
  }

  async get<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'GET' })
  }

  async post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async patch<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  }

  async delete<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' })
  }
}

export const apiClient = new ApiClient()
