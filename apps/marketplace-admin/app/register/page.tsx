'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button, Input } from '@/components/ui'
import { authService } from '@/services/auth'
import { ApiErrorResponse } from '@/services/api/client'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'

export default function RegisterPage() {
  const router = useRouter()
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [errors, setErrors] = useState<{
    name?: string
    email?: string
    password?: string
    confirmPassword?: string
    submit?: string
  }>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }))

    // Clear error for this field
    if (errors[name as keyof typeof errors]) {
      setErrors(prev => ({
        ...prev,
        [name]: undefined,
      }))
    }
  }

  const validateForm = (): boolean => {
    const newErrors: typeof errors = {}

    if (!formData.name.trim()) {
      newErrors.name = 'Name is required'
    }

    if (!formData.email.trim()) {
      newErrors.email = 'Email is required'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address'
    }

    if (!formData.password) {
      newErrors.password = 'Password is required'
    } else if (formData.password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters'
    }

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = 'Please confirm your password'
    } else if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    setIsSubmitting(true)
    setErrors({})

    try {
      await authService.register({
        name: formData.name,
        email: formData.email,
        password: formData.password,
      })

      // Redirect to login page after successful registration
      router.push('/login?registered=true')
    } catch (error) {
      setIsSubmitting(false)

      if (error instanceof ApiErrorResponse) {
        if (error.status === 422) {
          const detail = error.data.detail
          if (Array.isArray(detail)) {
            const newErrors: typeof errors = {}
            detail.forEach((err) => {
              const field = err.loc[err.loc.length - 1] as string
              if (field === 'email') {
                newErrors.email = err.msg
              } else if (field === 'password') {
                newErrors.password = err.msg
              } else if (field === 'name') {
                newErrors.name = err.msg
              } else {
                newErrors.submit = err.msg
              }
            })
            setErrors(newErrors)
          } else {
            setErrors({ submit: detail as string || 'Validation error' })
          }
        } else if (error.status === 409) {
          setErrors({ email: 'This email is already registered' })
        } else {
          setErrors({ submit: error.data.detail as string || 'Registration failed. Please try again.' })
        }
      } else if (error instanceof Error) {
        setErrors({ submit: error.message })
      } else {
        setErrors({ submit: 'Network error. Please check your connection and try again.' })
      }
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-8">
        {/* Logo/Title */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Vayada Admin</h1>
          <p className="text-gray-600">Create a new admin account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Name Field */}
          <div>
            <Input
              id="name"
              type="text"
              name="name"
              label="Full Name"
              value={formData.name}
              onChange={handleChange}
              required
              placeholder="John Doe"
              autoComplete="name"
              error={errors.name}
            />
          </div>

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
              error={errors.email}
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
                autoComplete="new-password"
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
            {errors.password && (
              <p className="mt-1.5 text-sm text-red-600">{errors.password}</p>
            )}
          </div>

          {/* Confirm Password Field */}
          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-2">
              Confirm Password
            </label>
            <div className="relative">
              <input
                id="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                name="confirmPassword"
                value={formData.confirmPassword}
                onChange={handleChange}
                required
                placeholder="Confirm your password"
                autoComplete="new-password"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent pr-12 text-gray-900"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
              >
                {showConfirmPassword ? (
                  <EyeSlashIcon className="w-5 h-5" />
                ) : (
                  <EyeIcon className="w-5 h-5" />
                )}
              </button>
            </div>
            {errors.confirmPassword && (
              <p className="mt-1.5 text-sm text-red-600">{errors.confirmPassword}</p>
            )}
          </div>

          {/* Error Message */}
          {errors.submit && (
            <div className="bg-red-50 border-2 border-red-300 rounded-lg p-4">
              <p className="text-sm text-red-800 font-semibold">{errors.submit}</p>
            </div>
          )}

          {/* Register Button */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating Account...' : 'Create Account'}
          </Button>

          {/* Login Link */}
          <div className="text-center">
            <p className="text-sm text-gray-600">
              Already have an account?{' '}
              <Link href="/login" className="text-primary-600 hover:text-primary-700 font-medium">
                Sign in
              </Link>
            </p>
          </div>
        </form>
      </div>
    </div>
  )
}

