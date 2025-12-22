/**
 * Authentication service for admin
 */

import { apiClient, ApiErrorResponse } from '../api/client'
import type { LoginRequest, LoginResponse } from '@/lib/types'

const TOKEN_KEY = 'access_token'
const EXPIRES_AT_KEY = 'token_expires_at'

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
   * Login user (admin)
   */
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    try {
      const response = await apiClient.post<LoginResponse>('/auth/login', data)
      
      // Verify user is admin
      if (response.type !== 'admin') {
        throw new Error('Access denied. Admin account required.')
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
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error
      }
      throw error
    }
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
    try {
      const response = await apiClient.get<LoginResponse>('/auth/me')
      return response
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error
      }
      throw new Error('Failed to get current user')
    }
  },

  /**
   * Check if user is logged in (has valid token)
   */
  isLoggedIn: (): boolean => {
    return getToken() !== null
  },

  /**
   * Check if current user is admin
   */
  isAdmin: (): boolean => {
    if (typeof window === 'undefined') return false
    const userType = localStorage.getItem('userType')
    return userType === 'admin'
  },

  /**
   * Get token if available and not expired
   */
  getToken: (): string | null => {
    return getToken()
  },
}

