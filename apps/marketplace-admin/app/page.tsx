'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'

export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    // Redirect to login if not authenticated, or dashboard if authenticated
    if (authService.isLoggedIn() && authService.isAdmin()) {
      router.push('/dashboard')
    } else {
      router.push('/login')
    }
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <p className="text-gray-600">Redirecting...</p>
      </div>
    </div>
  )
}

