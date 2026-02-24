'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
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
      router.push('/login?registered=true')
    } catch (error) {
      setIsSubmitting(false)

      if (error instanceof ApiErrorResponse) {
        if (error.status === 422) {
          const detail = error.data.detail
          if (Array.isArray(detail)) {
            const newFieldErrors: typeof fieldErrors = {}
            detail.forEach((err) => {
              const field = err.loc[err.loc.length - 1] as string
              if (field === 'email') {
                newFieldErrors.email = err.msg
              } else if (field === 'password') {
                newFieldErrors.password = err.msg
              } else if (field === 'name') {
                newFieldErrors.name = err.msg
              } else {
                setSubmitError(err.msg)
              }
            })
            setFieldErrors(newFieldErrors)
          } else {
            setSubmitError(detail as string || 'Validation error')
          }
        } else if (error.status === 409) {
          setFieldErrors({ email: 'This email is already registered' })
        } else {
          setSubmitError(error.data.detail as string || 'Registration failed. Please try again.')
        }
      } else if (error instanceof Error) {
        setSubmitError(error.message)
      } else {
        setSubmitError('Network error. Please check your connection and try again.')
      }
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        {/* Logo/Title */}
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <span className="text-white font-bold text-[16px]">V</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Vayada Admin</h1>
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
