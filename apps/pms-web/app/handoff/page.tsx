'use client'

import { useEffect } from 'react'

export default function HandoffPage() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    // Auth data in URL hash (not query) so it never hits server logs.
    const hashParams = new URLSearchParams(window.location.hash.slice(1))
    const token = hashParams.get('token')
    const expiresAt = hashParams.get('expires_at')
    const userData = hashParams.get('user')
    const handoffHotelId = hashParams.get('hotel_id')

    // Optional `?redirect=...` query param — honored if it's a
    // same-origin relative path, else ignored. Used when another
    // app needs to hand off and land on a specific page (e.g.
    // /choose-property, /setup?mode=add).
    const queryParams = new URLSearchParams(window.location.search)
    const redirectParam = queryParams.get('redirect')
    const safeRedirect =
      redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('//')
        ? redirectParam
        : null

    if (token && expiresAt) {
      localStorage.setItem('access_token', token)
      localStorage.setItem('token_expires_at', expiresAt)
      if (handoffHotelId) {
        localStorage.setItem('selectedHotelId', handoffHotelId)
      }
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

      // Check PMS setup status before redirecting.
      // Precedence: explicit safeRedirect > setup (if incomplete)
      // > choose-property (if 2+ hotels) > dashboard (default).
      const pmsApiUrl = process.env.NEXT_PUBLIC_PMS_API_URL || 'https://pms-api.vayada.com'
      const bookingApiUrl = process.env.NEXT_PUBLIC_AUTH_API_URL || 'https://booking-api.vayada.com'
      const setupStatusHeaders: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      }
      if (handoffHotelId) {
        setupStatusHeaders['X-Hotel-Id'] = handoffHotelId
      }
      fetch(`${pmsApiUrl}/admin/setup-status`, {
        headers: setupStatusHeaders,
      })
        .then(res => res.ok ? res.json() : null)
        .then(async data => {
          const setupComplete = !!(data && data.setup_complete)
          localStorage.setItem('pmsSetupComplete', setupComplete ? 'true' : 'false')

          if (safeRedirect) {
            window.location.href = safeRedirect
            return
          }
          if (!setupComplete) {
            window.location.href = '/setup'
            return
          }

          // If the caller already told us which hotel to land on,
          // honor it and skip the choose-property step.
          if (handoffHotelId) {
            window.location.href = '/dashboard'
            return
          }

          // Fetch the user's hotel list from the booking-engine API
          // (the source of truth after the multi-hotel ids unification).
          try {
            const listRes = await fetch(`${bookingApiUrl}/admin/hotels`, {
              headers: { Authorization: `Bearer ${token}` },
            })
            const hotels = listRes.ok ? await listRes.json() : []
            if (Array.isArray(hotels) && hotels.length > 1) {
              localStorage.removeItem('selectedHotelId')
              window.location.href = '/choose-property'
              return
            }
            if (Array.isArray(hotels) && hotels.length === 1) {
              localStorage.setItem('selectedHotelId', hotels[0].id)
            }
          } catch {
            // Fall through to dashboard if the list call fails.
          }
          window.location.href = '/dashboard'
        })
        .catch(() => {
          localStorage.setItem('pmsSetupComplete', 'true')
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
