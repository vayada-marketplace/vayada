/**
 * Authentication service for the affiliate dashboard
 * Uses the booking engine auth backend (port 8001)
 */

const AUTH_API_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || 'http://localhost:8001'

const TOKEN_KEY = 'access_token'
const EXPIRES_AT_KEY = 'token_expires_at'

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

export interface ResetPasswordRequest {
  token: string
  new_password: string
}

function storeToken(token: string, expiresIn: number): void {
  if (typeof window === 'undefined') return

  localStorage.setItem(TOKEN_KEY, token)
  const expiresAt = Date.now() + (expiresIn * 1000)
  localStorage.setItem(EXPIRES_AT_KEY, expiresAt.toString())
}

function storeUserData(data: { id: string; email: string; name: string; type: string; status: string }): void {
  if (typeof window === 'undefined') return

  localStorage.setItem('isLoggedIn', 'true')
  localStorage.setItem('userId', data.id)
  localStorage.setItem('userEmail', data.email)
  localStorage.setItem('userName', data.name)
  localStorage.setItem('userType', data.type)
  localStorage.setItem('userStatus', data.status)

  localStorage.setItem('user', JSON.stringify({
    id: data.id,
    email: data.email,
    name: data.name,
    type: data.type,
    status: data.status,
  }))
}

function clearAuthData(): void {
  if (typeof window === 'undefined') return

  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EXPIRES_AT_KEY)
  localStorage.removeItem('userId')
  localStorage.removeItem('userEmail')
  localStorage.removeItem('userName')
  localStorage.removeItem('userType')
  localStorage.removeItem('userStatus')
  localStorage.removeItem('user')
  localStorage.setItem('isLoggedIn', 'false')
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null

  const token = localStorage.getItem(TOKEN_KEY)
  const expiresAt = localStorage.getItem(EXPIRES_AT_KEY)

  if (!token || !expiresAt) return null

  if (Date.now() >= parseInt(expiresAt)) {
    clearAuthData()
    return null
  }

  return token
}

async function authFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${AUTH_API_URL}${endpoint}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  const response = await fetch(url, { ...options, headers })

  const contentType = response.headers.get('content-type')
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    const error = new Error(data?.detail || `API Error: ${response.status}`)
    ;(error as any).status = response.status
    ;(error as any).data = data
    throw error
  }

  return data as T
}

export const authService = {
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    const response = await authFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    })

    if (response.type !== 'affiliate') {
      throw new Error('Access denied. Affiliate account required.')
    }

    storeToken(response.access_token, response.expires_in)
    storeUserData({
      id: response.id,
      email: response.email,
      name: response.name,
      type: response.type,
      status: response.status,
    })

    return response
  },

  setPassword: async (data: ResetPasswordRequest): Promise<void> => {
    await authFetch('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  logout: (): void => {
    clearAuthData()
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
  },

  isLoggedIn: (): boolean => {
    return getToken() !== null
  },

  isAffiliate: (): boolean => {
    if (typeof window === 'undefined') return false
    const userType = localStorage.getItem('userType')
    return userType === 'affiliate'
  },

  getToken: (): string | null => {
    return getToken()
  },

  getUserName: (): string => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem('userName') || ''
  },

  getUserInitials: (): string => {
    const name = authService.getUserName()
    if (!name) return '?'
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    return name.substring(0, 2).toUpperCase()
  },
}
