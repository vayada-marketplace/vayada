'use client'

import { useState } from 'react'
import { authService } from '@/services/auth'
import ForgotPasswordForm from '@/components/auth/ForgotPasswordForm'

export default function ForgotPasswordPage() {
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleForgotPassword = async (email: string) => {
    setIsSubmitting(true)
    try {
      await authService.forgotPassword(email)
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
          <p className="text-[13px] text-gray-500 mt-1">Reset your password</p>
        </div>

        <ForgotPasswordForm
          onSubmit={handleForgotPassword}
          isSubmitting={isSubmitting}
        />
      </div>
    </div>
  )
}
