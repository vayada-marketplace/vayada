'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'

export default function Home() {
  const router = useRouter()

  useEffect(() => {
    if (authService.isLoggedIn() && authService.isHotelAdmin()) {
      router.replace('/dashboard')
    } else {
      router.replace('/login')
    }
  }, [router])

  return null
}
