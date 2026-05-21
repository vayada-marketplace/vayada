/**
 * Local user-display data for the affiliate dashboard.
 *
 * Auth tokens themselves now live in an httpOnly cookie set by the
 * auth backend on /auth/login — they are intentionally not in
 * localStorage and not readable from JS. This module only persists
 * non-sensitive UI state (display name, type) for the navbar and the
 * client-side "is logged in" hint.
 */

const USER_KEYS = ['userId', 'userEmail', 'userName', 'userType', 'userStatus', 'user'] as const

export interface StoredUser {
  id: string
  email: string
  name: string
  type: string
  status: string
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

/** Client-side hint based on the last successful login. The cookie is
 * httpOnly so we cannot inspect it directly; if the cookie has expired
 * server-side, the next API call will 401 and the API client redirects
 * to /login. The Next middleware does the authoritative gate at
 * navigation time. */
export function isLoggedInHint(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem('isLoggedIn') === 'true'
}
