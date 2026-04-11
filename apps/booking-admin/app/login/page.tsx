'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
import { isSetupComplete } from '@/lib/utils/setupStatus'
import { settingsService } from '@/services/settings'
import LoginForm from '@/components/auth/LoginForm'
import { useTranslation } from '@/lib/i18n'

export default function LoginPage() {
  const { t } = useTranslation()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [submitError, setSubmitError] = useState(
    searchParams.get('expired') === 'true' ? t('auth.login.errorSessionExpired') : ''
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

      // Pre-load the user's hotel list. Multi-hotel users are sent to
      // a dedicated picker so they land in the property they actually
      // want to work on, instead of an arbitrary "last-used" fallback.
      // Single-hotel users skip the picker for speed.
      const hotelList = await settingsService.listHotels()
      localStorage.setItem('setupComplete', 'true')

      if (hotelList.length > 1) {
        // Clear any stale selection — the picker will set a fresh one.
        localStorage.removeItem('selectedHotelId')
        router.push('/choose-property')
        return
      }

      if (hotelList.length === 1) {
        localStorage.setItem('selectedHotelId', hotelList[0].id)
      }
      router.push('/dashboard')
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        if (error.status === 401) {
          setSubmitError(t('auth.login.errorInvalidCredentials'))
        } else if (error.status === 403) {
          setSubmitError(t('auth.login.errorSuspended'))
        } else if (error.status === 422) {
          const detail = error.data.detail
          if (Array.isArray(detail)) {
            setSubmitError(detail.map(e => e.msg).join('. '))
          } else {
            setSubmitError(detail || t('auth.login.errorValidation'))
          }
        } else {
          setSubmitError(t('auth.login.errorUnexpected'))
        }
      } else if (error instanceof Error) {
        setSubmitError(error.message)
      } else {
        setSubmitError(t('auth.login.errorUnexpected'))
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
          <h1 className="text-xl font-bold text-gray-900">{t('auth.login.title')}</h1>
          <p className="text-[13px] text-gray-500 mt-1">{t('auth.login.subtitle')}</p>
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
