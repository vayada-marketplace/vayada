'use client'

import { useEffect } from 'react'

export default function HandoffPage() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    // Auth data arrives in the URL hash so it never hits server logs.
    const hashParams = new URLSearchParams(window.location.hash.slice(1))
    const token = hashParams.get('token')
    const expiresAt = hashParams.get('expires_at')
    const userData = hashParams.get('user')

    // Optional `?redirect=...` query param tells us where to go after
    // auth. Used by the PMS header's "Add Property" button which
    // needs to land on /setup?mode=add instead of /dashboard.
    const queryParams = new URLSearchParams(window.location.search)
    const redirectParam = queryParams.get('redirect')
    // Only honor same-origin relative paths — never trust an arbitrary URL
    const safeRedirect =
      redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('//')
        ? redirectParam
        : null

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

      // Check setup status before redirecting
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://booking-api.vayada.com'
      fetch(`${apiUrl}/admin/settings/setup-status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && data.setup_complete) {
            localStorage.setItem('setupComplete', 'true')
          } else {
            localStorage.setItem('setupComplete', 'false')
          }
          window.location.href = safeRedirect || '/dashboard'
        })
        .catch(() => {
          localStorage.setItem('setupComplete', 'true')
          window.location.href = safeRedirect || '/dashboard'
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
