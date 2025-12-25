'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()

  useEffect(() => {
    if (!authService.isLoggedIn() || !authService.isAdmin()) {
      router.push('/login')
    }
  }, [router])

  return <>{children}</>
}

