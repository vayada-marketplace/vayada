'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
import { isSetupComplete } from '@/lib/utils/setupStatus'
import RegisterForm from '@/components/auth/RegisterForm'

export default function RegisterPage() {
  const router = useRouter()
  const [submitError, setSubmitError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string; email?: string; password?: string; confirmPassword?: string
  }>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleRegister = async (data: { name: string; email: string; password: string }) => {
    setSubmitError('')
    setFieldErrors({})
    setIsSubmitting(true)

    try {
      await authService.register(data)
      const complete = await isSetupComplete()
      if (!complete) {
        localStorage.setItem('setupComplete', 'false')
        router.push('/setup')
        return
      }
      localStorage.setItem('setupComplete', 'true')
      router.push('/dashboard')
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        if (error.status === 400) {
          setSubmitError('An account with this email already exists.')
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
          <p className="text-[13px] text-gray-500 mt-1">Create a new admin account</p>
        </div>

        <RegisterForm
          onSubmit={handleRegister}
          isSubmitting={isSubmitting}
          submitError={submitError}
          fieldErrors={fieldErrors}
          onErrorClear={() => { setSubmitError(''); setFieldErrors({}) }}
        />
      </div>
    </div>
  )
}
