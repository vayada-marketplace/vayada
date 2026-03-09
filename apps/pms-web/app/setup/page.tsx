'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { checkPmsSetupStatus } from '@/lib/utils/setupStatus'

const BOOKING_ADMIN_URL = process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || 'https://admin.booking.vayada.com'

export default function PmsSetupPage() {
  const router = useRouter()

  useEffect(() => {
    async function init() {
      if (!authService.isLoggedIn() || !authService.isHotelAdmin()) {
        router.replace('/login')
        return
      }

      // If setup is already complete, go to dashboard
      const status = await checkPmsSetupStatus()
      if (status?.setupComplete) {
        localStorage.setItem('pmsSetupComplete', 'true')
        router.replace('/dashboard')
        return
      }

      // Redirect to the shared onboarding flow in the booking engine admin
      // Pass auth data via URL hash so the booking engine can pick it up
      const token = localStorage.getItem('access_token')
      const expiresAt = localStorage.getItem('token_expires_at')
      const user = localStorage.getItem('user')

      if (token && expiresAt) {
        const params = new URLSearchParams({
          token,
          expires_at: expiresAt,
          from: 'pms',
          ...(user ? { user: encodeURIComponent(user) } : {}),
        })
        window.location.href = `${BOOKING_ADMIN_URL}/setup#${params.toString()}`
      } else {
        router.replace('/login')
      }
    }
    init()
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
