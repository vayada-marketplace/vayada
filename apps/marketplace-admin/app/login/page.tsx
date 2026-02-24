'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
import LoginForm from '@/components/auth/LoginForm'

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [sessionExpired, setSessionExpired] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (searchParams.get('expired') === 'true') {
      setSessionExpired(true)
    }
  }, [searchParams])

  const handleLogin = async (email: string, password: string) => {
    setSubmitError('')
    setIsSubmitting(true)

    try {
      const response = await authService.login({ email, password })

      // Verify admin type
      if (response.type !== 'admin') {
        setSubmitError('Access denied. Admin account required.')
        setIsSubmitting(false)
        authService.logout()
        return
      }

      router.push('/dashboard')
    } catch (error) {
      setIsSubmitting(false)

      if (error instanceof ApiErrorResponse) {
        if (error.status === 401) {
          setSubmitError('Invalid email or password')
        } else if (error.status === 403) {
          setSubmitError('Your account has been suspended. Please contact support.')
        } else if (error.status === 422) {
          const detail = error.data.detail
          if (Array.isArray(detail)) {
            setSubmitError(detail.map(e => e.msg).join('. '))
          } else {
            setSubmitError(detail as string || 'Validation error')
          }
        } else {
          setSubmitError(error.data.detail as string || 'Login failed. Please try again.')
        }
      } else if (error instanceof Error) {
        setSubmitError(error.message)
      } else {
        setSubmitError('Network error. Please check your connection and try again.')
      }
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-8">
        {/* Logo/Title */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Vayada Admin</h1>
          <p className="text-gray-600">Sign in to access the admin panel</p>
        </div>

        <LoginForm
          onSubmit={handleLogin}
          isSubmitting={isSubmitting}
          submitError={submitError}
          onErrorClear={() => setSubmitError('')}
          sessionExpired={sessionExpired}
        />
      </div>
    </div>
  )
}
