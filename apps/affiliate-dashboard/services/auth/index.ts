/**
 * Authentication service for the affiliate dashboard
 * Uses the booking engine auth backend (port 8001)
 */

import { ApiClient } from '@/services/api/client'
import {
  clearAuthData,
  getToken,
  getUserName,
  getUserType,
  storeToken,
  storeUser,
} from './storage'

const AUTH_API_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || 'http://localhost:8001'

const authClient = new ApiClient(AUTH_API_URL)

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

export const authService = {
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    const response = await authClient.post<LoginResponse>('/auth/login', data)

    if (response.type !== 'affiliate') {
      throw new Error('Access denied. Affiliate account required.')
    }

    storeToken(response.access_token, response.expires_in)
    storeUser({
      id: response.id,
      email: response.email,
      name: response.name,
      type: response.type,
      status: response.status,
    })

    return response
  },

  setPassword: async (data: ResetPasswordRequest): Promise<void> => {
    await authClient.post('/auth/reset-password', data)
  },

  logout: (): void => {
    clearAuthData()
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
  },

  isLoggedIn: (): boolean => getToken() !== null,

  isAffiliate: (): boolean => getUserType() === 'affiliate',

  getToken,

  getUserName,

  getUserInitials: (): string => {
    const name = getUserName()
    if (!name) return '?'
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    return name.substring(0, 2).toUpperCase()
  },
}
