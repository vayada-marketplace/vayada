'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
import ResetPasswordForm from '@/components/auth/ResetPasswordForm'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [submitError, setSubmitError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleResetPassword = async (token: string, password: string) => {
    setSubmitError('')
    setIsSubmitting(true)

    try {
      await authService.resetPassword(token, password)
    } catch (error) {
      setIsSubmitting(false)

      if (error instanceof ApiErrorResponse) {
        if (error.status === 400) {
          setSubmitError('Invalid or expired reset token. Please request a new one.')
        } else {
          setSubmitError('An unexpected error occurred. Please try again.')
        }
      } else {
        setSubmitError('An unexpected error occurred. Please try again.')
      }

      throw error
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
          <p className="text-[13px] text-gray-500 mt-1">Set your new password</p>
        </div>

        <ResetPasswordForm
          onSubmit={handleResetPassword}
          isSubmitting={isSubmitting}
          submitError={submitError}
          onErrorClear={() => setSubmitError('')}
          onSuccess={() => router.push('/login')}
        />
      </div>
    </div>
  )
}
