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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-8">
        {/* Logo/Title */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Vayada Admin</h1>
          <p className="text-gray-600">Reset your password</p>
        </div>

        <ForgotPasswordForm
          onSubmit={handleForgotPassword}
          isSubmitting={isSubmitting}
        />
      </div>
    </div>
  )
}
