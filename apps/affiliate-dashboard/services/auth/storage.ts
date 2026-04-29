/**
 * Shared localStorage layer for auth tokens + user data.
 *
 * All access to the auth-related localStorage keys goes through this module
 * so the storage shape stays consistent across the API client and the
 * authService.
 */

const TOKEN_KEY = 'access_token'
const EXPIRES_AT_KEY = 'token_expires_at'

const USER_KEYS = ['userId', 'userEmail', 'userName', 'userType', 'userStatus', 'user'] as const

export interface StoredUser {
  id: string
  email: string
  name: string
  type: string
  status: string
}

export function getToken(): string | null {
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

export function storeToken(token: string, expiresIn: number): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(EXPIRES_AT_KEY, (Date.now() + expiresIn * 1000).toString())
}

export function storeUser(data: StoredUser): void {
  if (typeof window === 'undefined') return
  localStorage.setItem('isLoggedIn', 'true')
  localStorage.setItem('userId', data.id)
  localStorage.setItem('userEmail', data.email)
  localStorage.setItem('userName', data.name)
  localStorage.setItem('userType', data.type)
  localStorage.setItem('userStatus', data.status)
  localStorage.setItem('user', JSON.stringify(data))
}

export function clearAuthData(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EXPIRES_AT_KEY)
  for (const key of USER_KEYS) localStorage.removeItem(key)
  localStorage.setItem('isLoggedIn', 'false')
}

export function getUserType(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('userType')
}

export function getUserName(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('userName') || ''
}
