'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
import { isSetupComplete } from '@/lib/utils/setupStatus'
import { settingsService } from '@/services/settings'
import LoginForm from '@/components/auth/LoginForm'

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [submitError, setSubmitError] = useState(
    searchParams.get('expired') === 'true' ? 'Your session has expired. Please sign in again.' : ''
  )
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleLogin = async (email: string, password: string) => {
    setSubmitError('')
    setIsSubmitting(true)

    try {
      const loginResponse = await authService.login({ email, password })

      // Super admins skip setup check and go straight to manage hotels
      if (loginResponse.is_superadmin) {
        localStorage.setItem('setupComplete', 'true')
        router.push('/manage-hotels')
        return
      }

      const complete = await isSetupComplete()
      if (!complete) {
        localStorage.setItem('setupComplete', 'false')
        router.push('/setup')
        return
      }

      // Pre-load hotel selection
      const hotelList = await settingsService.listHotels()
      if (hotelList.length > 0) {
        const savedId = localStorage.getItem('selectedHotelId')
        if (!hotelList.find(h => h.id === savedId)) {
          localStorage.setItem('selectedHotelId', hotelList[0].id)
        }
      }

      localStorage.setItem('setupComplete', 'true')
      router.push('/dashboard')
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        if (error.status === 401) {
          setSubmitError('Invalid email or password.')
        } else if (error.status === 403) {
          setSubmitError('Your account has been suspended. Please contact support.')
        } else if (error.status === 422) {
          const detail = error.data.detail
          if (Array.isArray(detail)) {
            setSubmitError(detail.map(e => e.msg).join('. '))
          } else {
            setSubmitError(detail || 'Validation error.')
          }
        } else {
          setSubmitError('An unexpected error occurred. Please try again.')
        }
      } else if (error instanceof Error) {
        setSubmitError(error.message)
      } else {
        setSubmitError('An unexpected error occurred. Please try again.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        {/* Logo / Title */}
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <span className="text-white font-bold text-[16px]">B</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Booking Engine</h1>
          <p className="text-[13px] text-gray-500 mt-1">Sign in to the admin panel</p>
        </div>

        <LoginForm
          onSubmit={handleLogin}
          isSubmitting={isSubmitting}
          submitError={submitError}
          onErrorClear={() => setSubmitError('')}
        />
      </div>
    </div>
  )
}
