'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button, Input } from '@/components/ui'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tokenExpired, setTokenExpired] = useState(false)
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [emailError, setEmailError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Check if token expired or if registered
  useEffect(() => {
    if (searchParams.get('expired') === 'true') {
      setTokenExpired(true)
    }
    
    if (searchParams.get('registered') === 'true') {
      setSubmitError('')
      // Show success message could be added here
    }
  }, [searchParams])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }))

    if (name === 'email' && emailError) {
      setEmailError('')
    }
  }

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
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
      const response = await authService.login({
        email: formData.email,
        password: formData.password,
      })

      // Verify admin type
      if (response.type !== 'admin') {
        setSubmitError('Access denied. Admin account required.')
        setIsSubmitting(false)
        authService.logout()
        return
      }

      // Redirect to dashboard
      router.push('/dashboard')
    } catch (error) {
      setIsSubmitting(false)
      setFormData(prev => ({ ...prev, password: '' }))

      if (error instanceof ApiErrorResponse) {
        if (error.status === 401) {
          setSubmitError('Invalid email or password')
        } else if (error.status === 403) {
          setSubmitError('Your account has been suspended. Please contact support.')
        } else if (error.status === 422) {
          const detail = error.data.detail
          if (Array.isArray(detail)) {
            detail.forEach((err) => {
              const field = err.loc[err.loc.length - 1] as string
              if (field === 'email') {
                setEmailError(err.msg)
              } else {
                setSubmitError(err.msg)
              }
            })
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

        <form onSubmit={handleSubmit} className="space-y-6">
          {tokenExpired && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-sm text-yellow-800 font-medium">
                Your session has expired. Please login again.
              </p>
            </div>
          )}

          {/* Email Field */}
          <div>
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
          </div>

          {/* Password Field */}
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
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
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent pr-12 text-gray-900"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
              >
                {showPassword ? (
                  <EyeSlashIcon className="w-5 h-5" />
                ) : (
                  <EyeIcon className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>

          {/* Error Message */}
          {submitError && (
            <div className="bg-red-50 border-2 border-red-300 rounded-lg p-4">
              <p className="text-sm text-red-800 font-semibold">{submitError}</p>
            </div>
          )}

          {/* Sign In Button */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Signing In...' : 'Sign In'}
          </Button>

          {/* Register Link */}
          <div className="text-center">
            <p className="text-sm text-gray-600">
              Don't have an account?{' '}
              <a href="/register" className="text-primary-600 hover:text-primary-700 font-medium">
                Sign up
              </a>
            </p>
          </div>
        </form>
      </div>
    </div>
  )
}

