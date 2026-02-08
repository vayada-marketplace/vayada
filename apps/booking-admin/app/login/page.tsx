'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'

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
            <span className="text-white font-bold text-[16px]">B</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Booking Engine</h1>
          <p className="text-[13px] text-gray-500 mt-1">Sign in to the admin panel</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email */}
          <Input
            id="email"
            type="email"
            name="email"
            label="Email address"
            value={formData.email}
            onChange={handleChange}
            required
            placeholder="admin@example.com"
            autoComplete="email"
            error={emailError}
          />

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
                  <EyeSlashIcon className="w-4 h-4" />
                ) : (
                  <EyeIcon className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* Forgot password */}
          <div className="text-right">
            <Link href="/forgot-password" className="text-[13px] text-primary-600 hover:text-primary-700 font-medium">
              Forgot password?
            </Link>
          </div>

          {/* Submit Error */}
          {submitError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-[12px] text-red-700 font-medium">{submitError}</p>
            </div>
          )}

          {/* Submit */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Signing In...' : 'Sign In'}
          </Button>

          {/* Register link */}
          <p className="text-center text-[13px] text-gray-500">
            Don&apos;t have an account?{' '}
            <Link href="/register" className="text-primary-600 hover:text-primary-700 font-medium">
              Sign up
            </Link>
          </p>
        </form>
      </div>
    </div>
  )
}
