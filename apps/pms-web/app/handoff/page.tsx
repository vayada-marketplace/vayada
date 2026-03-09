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

      // Check PMS setup status before redirecting
      const pmsApiUrl = process.env.NEXT_PUBLIC_PMS_API_URL || 'https://pms-api.vayada.com'
      fetch(`${pmsApiUrl}/admin/setup-status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && data.setup_complete) {
            localStorage.setItem('pmsSetupComplete', 'true')
          } else {
            localStorage.setItem('pmsSetupComplete', 'false')
          }
          window.location.href = '/dashboard'
        })
        .catch(() => {
          // On error, still try dashboard — the layout will handle it
          localStorage.setItem('pmsSetupComplete', 'true')
          window.location.href = '/dashboard'
        })
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
