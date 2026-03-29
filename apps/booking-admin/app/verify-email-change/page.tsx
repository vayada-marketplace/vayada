'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { settingsService } from '@/services/settings'
import { ApiErrorResponse } from '@/services/api/client'
import { useTranslation } from '@/lib/i18n'

function VerifyEmailChangeContent() {
  const { t } = useTranslation()
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = searchParams.get('token')

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [newEmail, setNewEmail] = useState('')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setMessage(t('auth.verifyEmail.errorNoToken'))
      return
    }

    settingsService.verifyEmailChange(token)
      .then((res) => {
        setStatus('success')
        setMessage(res.message || t('auth.verifyEmail.successDefault'))
        setNewEmail(res.email)
        setTimeout(() => router.push('/login'), 3000)
      })
      .catch((err) => {
        setStatus('error')
        if (err instanceof ApiErrorResponse) {
          setMessage(err.message || t('auth.verifyEmail.errorVerificationFailed'))
        } else {
          setMessage(t('auth.verifyEmail.errorUnexpected'))
        }
      })
  }, [token, router, t])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8 text-center">
        <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
          <span className="text-white font-bold text-[16px]">B</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-1">{t('auth.verifyEmail.title')}</h1>

        {status === 'loading' && (
          <>
            <div className="mt-6 flex justify-center">
              <div className="w-8 h-8 border-4 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
            </div>
            <p className="text-[13px] text-gray-500 mt-3">{t('auth.verifyEmail.loading')}</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="mt-6 inline-flex items-center justify-center w-12 h-12 bg-green-100 rounded-full">
              <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-[13px] text-gray-700 mt-3 font-medium">{message}</p>
            {newEmail && (
              <p className="text-[13px] text-gray-500 mt-1">{t('auth.verifyEmail.newEmailMessage')} <strong>{newEmail}</strong></p>
            )}
            <p className="text-[12px] text-gray-400 mt-3">{t('auth.verifyEmail.redirecting')}</p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="mt-6 inline-flex items-center justify-center w-12 h-12 bg-red-100 rounded-full">
              <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-[13px] text-gray-700 mt-3 font-medium">{message}</p>
            <button
              onClick={() => router.push('/login')}
              className="mt-4 text-[13px] text-primary-600 hover:text-primary-700 font-medium"
            >
              {t('auth.verifyEmail.goToLogin')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function VerifyEmailChangePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-4 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
      </div>
    }>
      <VerifyEmailChangeContent />
    </Suspense>
  )
}
