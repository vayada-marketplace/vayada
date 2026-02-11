'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { isSetupComplete } from '@/lib/utils/setupStatus'

export default function Home() {
  const router = useRouter()

  useEffect(() => {
    async function redirect() {
      if (authService.isLoggedIn() && authService.isHotelAdmin()) {
        const complete = await isSetupComplete()
        router.replace(complete ? '/dashboard' : '/setup')
      } else {
        router.replace('/login')
      }
    }
    redirect()
  }, [router])

  return null
}
