/**
 * Authentication service for PMS frontend
 * Uses the same booking engine auth backend (port 8001)
 */

import { apiClient } from '../api/client'

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

export const authService = {
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    const response = await apiClient.post<LoginResponse>('/auth/login', data)

    if (response.type !== 'hotel') {
      throw new Error('Access denied. Hotel admin account required.')
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

  logout: (): void => {
    clearAuthData()
    if (typeof window !== 'undefined') {
      localStorage.removeItem('pmsSetupComplete')
      window.location.href = '/login'
    }
  },

  isLoggedIn: (): boolean => {
    return getToken() !== null
  },

  isHotelAdmin: (): boolean => {
    if (typeof window === 'undefined') return false
    const userType = localStorage.getItem('userType')
    return userType === 'hotel'
  },

  getToken: (): string | null => {
    return getToken()
  },
}
