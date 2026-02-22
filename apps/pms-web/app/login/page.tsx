'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
import { checkPmsSetupStatus } from '@/lib/utils/setupStatus'

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [emailError, setEmailError] = useState('')
  const [submitError, setSubmitError] = useState(
    searchParams.get('expired') === 'true' ? 'Your session has expired. Please sign in again.' : ''
  )
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))

    if (name === 'email' && emailError) {
      setEmailError('')
    }
    if (submitError) {
      setSubmitError('')
    }
  }

  const validateEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setEmailError('')
    setSubmitError('')

    if (!validateEmail(formData.email)) {
      setEmailError('Please enter a valid email address')
      return
    }

    setIsSubmitting(true)

    try {
      await authService.login({ email: formData.email, password: formData.password })

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
      setFormData(prev => ({ ...prev, password: '' }))
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

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email */}
          <div>
            <label htmlFor="email" className="block text-[13px] font-medium text-gray-700 mb-1.5">
              Email address
            </label>
            <input
              id="email"
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              required
              placeholder="admin@example.com"
              autoComplete="email"
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-[13px] text-gray-900 ${
                emailError ? 'border-red-300 ring-1 ring-red-300' : 'border-gray-300'
              }`}
            />
            {emailError && (
              <p className="mt-1 text-[12px] text-red-600">{emailError}</p>
            )}
          </div>

          {/* Password */}
          <div>
            <label htmlFor="password" className="block text-[13px] font-medium text-gray-700 mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={formData.password}
                onChange={handleChange}
                required
                placeholder="Enter your password"
                autoComplete="current-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent pr-10 text-[13px] text-gray-900"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showPassword ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Submit Error */}
          {submitError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-[12px] text-red-700 font-medium">{submitError}</p>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full px-4 py-2.5 bg-primary-600 text-white text-[13px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? 'Signing In...' : 'Sign In'}
          </button>

          {/* Booking Engine link */}
          <p className="text-center text-[13px] text-gray-500">
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
        </form>
      </div>
    </div>
  )
}
