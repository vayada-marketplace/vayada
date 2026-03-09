'use client'

import { useEffect } from 'react'

export default function HandoffPage() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    const params = new URLSearchParams(window.location.hash.slice(1))
    const token = params.get('token')
    const expiresAt = params.get('expires_at')
    const userData = params.get('user')

    if (token && expiresAt) {
      localStorage.setItem('access_token', token)
      localStorage.setItem('token_expires_at', expiresAt)
      if (userData) {
        try {
          const user = JSON.parse(decodeURIComponent(userData))
          localStorage.setItem('isLoggedIn', 'true')
          localStorage.setItem('userId', user.id)
          localStorage.setItem('userEmail', user.email)
          localStorage.setItem('userName', user.name)
          localStorage.setItem('userType', user.type)
          localStorage.setItem('userStatus', user.status)
          localStorage.setItem('user', JSON.stringify(user))
        } catch { /* ignore */ }
      }
      window.location.href = '/dashboard'
    } else {
      window.location.href = '/login'
    }
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
