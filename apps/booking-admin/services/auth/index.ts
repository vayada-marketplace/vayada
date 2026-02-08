/**
 * Authentication service for booking engine admin
 */

import { apiClient, ApiErrorResponse } from '../api/client'

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

export interface RegisterRequest {
  name: string
  email: string
  password: string
}

export interface RegisterResponse {
  message: string
  id: string
  email: string
  name: string
  access_token: string
  token_type: string
  expires_in: number
  type: string
  status: string
}

/**
 * Store JWT token and expiration time
 */
function storeToken(token: string, expiresIn: number): void {
  if (typeof window === 'undefined') return

  localStorage.setItem(TOKEN_KEY, token)
  const expiresAt = Date.now() + (expiresIn * 1000)
  localStorage.setItem(EXPIRES_AT_KEY, expiresAt.toString())
}

/**
 * Store user data in localStorage
 */
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

/**
 * Clear all auth data from localStorage
 */
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

/**
 * Get token if not expired
 */
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

export const authService = {
  /**
   * Register a new hotel admin user
   */
  register: async (data: RegisterRequest): Promise<RegisterResponse> => {
    const response = await apiClient.post<RegisterResponse>('/auth/register', {
      ...data,
      terms_accepted: true,
      privacy_accepted: true,
    })

    // Store token and user data, then redirect to dashboard
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

  /**
   * Login user (hotel admin)
   */
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    const response = await apiClient.post<LoginResponse>('/auth/login', data)

    // Verify user is hotel admin
    if (response.type !== 'hotel') {
      throw new Error('Access denied. Hotel admin account required.')
    }

    // Store token and user data
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

  /**
   * Logout user
   */
  logout: (): void => {
    clearAuthData()

    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
  },

  /**
   * Get current user
   */
  getCurrentUser: async () => {
    const response = await apiClient.get<LoginResponse>('/admin/me')
    return response
  },

  /**
   * Check if user is logged in (has valid token)
   */
  isLoggedIn: (): boolean => {
    return getToken() !== null
  },

  /**
   * Check if current user is hotel admin
   */
  isHotelAdmin: (): boolean => {
    if (typeof window === 'undefined') return false
    const userType = localStorage.getItem('userType')
    return userType === 'hotel'
  },

  /**
   * Get token if available and not expired
   */
  getToken: (): string | null => {
    return getToken()
  },
}
