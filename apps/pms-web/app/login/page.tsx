'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
import { checkPmsSetupStatus } from '@/lib/utils/setupStatus'
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
      await authService.login({ email, password })

      // Check PMS setup status
      const status = await checkPmsSetupStatus()

      if (!status || !status.registered) {
        setSubmitError('Please complete the booking engine setup first. Visit the Booking Engine Admin to register your hotel.')
        setIsSubmitting(false)
        return
      }

      if (!status.setupComplete) {
        localStorage.setItem('pmsSetupComplete', 'false')
        router.push('/setup')
      } else {
        localStorage.setItem('pmsSetupComplete', 'true')
        router.push('/dashboard')
      }
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
              <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
              <path d="M3 7h18" />
              <path d="M8 11h8" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Vayada PMS</h1>
          <p className="text-[13px] text-gray-500 mt-1">Sign in to manage your property</p>
        </div>

        <LoginForm
          onSubmit={handleLogin}
          isSubmitting={isSubmitting}
          submitError={submitError}
          onErrorClear={() => setSubmitError('')}
          showForgotPassword={false}
          showRegister={false}
        />

        {/* Booking Engine link */}
        <p className="text-center text-[13px] text-gray-500 mt-5">
          Need to set up your booking engine?{' '}
          <a
            href={process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || 'https://admin.booking.vayada.com'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-600 hover:text-primary-700 font-medium"
          >
            Go to Booking Engine
          </a>
        </p>
      </div>
    </div>
  )
}
