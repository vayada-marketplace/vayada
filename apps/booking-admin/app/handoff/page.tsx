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
    const handoffHotelId = hashParams.get('hotel_id')

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

      // Check setup status before redirecting.
      // Precedence: explicit safeRedirect > setup (if incomplete)
      // > choose-property (if 2+ hotels) > dashboard (default).
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://booking-api.vayada.com'
      fetch(`${apiUrl}/admin/settings/setup-status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(res => res.ok ? res.json() : null)
        .then(async data => {
          const setupComplete = !!(data && data.setup_complete)
          localStorage.setItem('setupComplete', setupComplete ? 'true' : 'false')

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

          // Check how many hotels the user owns. Multi-hotel users
          // get the picker so cross-domain handoff doesn't silently
          // drop them into an arbitrary dashboard.
          try {
            const listRes = await fetch(`${apiUrl}/admin/hotels`, {
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
            // If the list call fails, fall through to dashboard —
            // the dashboard will use its own fallback logic.
          }
          window.location.href = '/dashboard'
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
