'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

const PMS_URL = process.env.NEXT_PUBLIC_PMS_URL || ''

function formatApiError(err: any, fallback: string): string {
  const detail = err?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d: any) => {
        const field = Array.isArray(d?.loc) ? d.loc[d.loc.length - 1] : ''
        const msg = d?.msg || 'Invalid value'
        return field ? `${field}: ${msg}` : msg
      })
      .join(', ')
  }
  return fallback
}

export default function ReferModal({ open, onClose, hotelSlug }: { open: boolean; onClose: () => void; hotelSlug: string }) {
  const t = useTranslations('refer')
  const tc = useTranslations('common')
  const [step, setStep] = useState(1)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [social, setSocial] = useState('')
  const [userType, setUserType] = useState<'guest' | 'creator'>('guest')
  const [paymentMethod, setPaymentMethod] = useState<'stripe' | 'paypal' | 'bank'>('stripe')
  const [paypalEmail, setPaypalEmail] = useState('')
  const [bankIban, setBankIban] = useState('')
  const [bankAccountHolder, setBankAccountHolder] = useState('')
  const [bankSwiftBic, setBankSwiftBic] = useState('')
  const [bankName, setBankName] = useState('')
  const [bankCountry, setBankCountry] = useState('')
  const [copied, setCopied] = useState(false)
  const [referralCode, setReferralCode] = useState('')
  const [affiliateId, setAffiliateId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [stripeConnected, setStripeConnected] = useState(false)
  const [apiError, setApiError] = useState('')

  const referralDomain = `${hotelSlug}.booking.vayada.com`

  const handleContinueInfo = async () => {
    if (!fullName || !email) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setApiError('Please enter a valid email address')
      return
    }
    setSubmitting(true)
    setApiError('')
    try {
      const res = await fetch(
        `${PMS_URL}/api/hotels/${hotelSlug}/affiliates/check-email?email=${encodeURIComponent(email.trim())}`,
      )
      if (res.ok) {
        const data = await res.json()
        if (data?.exists) {
          setApiError('An affiliate with this email already exists for this hotel')
          return
        }
      }
      setStep(2)
    } catch {
      // If the check call itself fails, fall through and let step 2
      // surface any errors — better to let the user continue than
      // block them on a transient network blip.
      setStep(2)
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmitPayout = async () => {
    if (paymentMethod === 'paypal' && !paypalEmail) {
      setApiError('Please enter your PayPal email')
      return
    }
    if (paymentMethod === 'bank') {
      if (!bankAccountHolder) { setApiError('Please enter the account holder name'); return }
      if (!bankIban) { setApiError('Please enter your IBAN or account number'); return }
      if (!bankSwiftBic) { setApiError('Please enter the SWIFT/BIC code'); return }
      if (!bankName) { setApiError('Please enter the bank name'); return }
      if (!bankCountry) { setApiError('Please enter the bank country'); return }
    }
    setSubmitting(true)
    setApiError('')
    try {
      const res = await fetch(`${PMS_URL}/api/hotels/${hotelSlug}/affiliates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName,
          email,
          socialMedia: social,
          userType,
          paymentMethod,
          paypalEmail: paymentMethod === 'paypal' ? paypalEmail : '',
          bankIban: paymentMethod === 'bank' ? bankIban : '',
          bankAccountHolder: paymentMethod === 'bank' ? bankAccountHolder : '',
          bankSwiftBic: paymentMethod === 'bank' ? bankSwiftBic : '',
          bankName: paymentMethod === 'bank' ? bankName : '',
          bankCountry: paymentMethod === 'bank' ? bankCountry : '',
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Registration failed' }))
        throw new Error(formatApiError(err, 'Registration failed'))
      }
      const data = await res.json()
      setReferralCode(data.referralCode)
      setAffiliateId(data.id)

      if (paymentMethod === 'stripe') {
        try {
          const stripeRes = await fetch(`${PMS_URL}/api/hotels/${hotelSlug}/affiliates/${data.id}/stripe/connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          })
          if (stripeRes.ok) {
            const stripeData = await stripeRes.json()
            setStripeConnected(true)
            window.open(stripeData.onboardingUrl, '_blank')
          }
        } catch {}
      }

      setStep(3)
    } catch (err: any) {
      setApiError(err.message || 'Failed to register')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(`${referralDomain}?ref=${referralCode}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const reset = () => {
    setStep(1)
    setFullName('')
    setEmail('')
    setSocial('')
    setUserType('guest')
    setPaymentMethod('stripe')
    setPaypalEmail('')
    setBankIban('')
    setBankAccountHolder('')
    setBankSwiftBic('')
    setBankName('')
    setBankCountry('')
    setCopied(false)
    setReferralCode('')
    setAffiliateId('')
    setStripeConnected(false)
    setApiError('')
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-2">
          <h2 className="text-xl font-bold text-gray-900">{t('title')}</h2>
          <button
            onClick={() => { onClose(); reset() }}
            className="p-1 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Subtitle */}
        <p className="px-6 text-sm text-gray-500 mb-4">
          {step === 1 && t('step1Desc')}
          {step === 2 && t('step2Desc')}
          {step === 3 && t('step3Desc')}
        </p>

        {/* Step Indicator */}
        <div className="flex items-center justify-center gap-0 px-6 mb-6">
          {[1, 2, 3].map((s, i) => (
            <div key={s} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 ${
                  s <= step
                    ? 'bg-primary-600 border-primary-600 text-white'
                    : 'bg-white border-gray-300 text-gray-400'
                }`}
              >
                {s < step ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  s
                )}
              </div>
              {i < 2 && (
                <div className={`w-10 h-0.5 ${s < step ? 'bg-primary-600' : 'bg-gray-300'}`} />
              )}
            </div>
          ))}
        </div>

        <div className="px-6 pb-6">
          {/* Step 1: Personal Info */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1.5">
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  {t('fullName')}
                </label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="John Doe"
                  className="w-full px-4 py-3 rounded-xl border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1.5">
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  {t('emailAddress')}
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="john@example.com"
                  className="w-full px-4 py-3 rounded-xl border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                />
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1.5">
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  {t('socialMedia')}
                </label>
                <input
                  type="text"
                  value={social}
                  onChange={(e) => setSocial(e.target.value)}
                  placeholder="@yourusername"
                  className="w-full px-4 py-3 rounded-xl border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                />
              </div>

              {/* I am a... */}
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">{t('iAmA')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setUserType('guest')}
                    className={`flex items-center justify-center gap-2 py-3 rounded-xl border-2 text-sm font-semibold transition-colors ${
                      userType === 'guest'
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <span>🏨</span> {t('guest')}
                  </button>
                  <button
                    onClick={() => setUserType('creator')}
                    className={`flex items-center justify-center gap-2 py-3 rounded-xl border-2 text-sm font-semibold transition-colors ${
                      userType === 'creator'
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <span>🌍</span> {t('creator')}
                  </button>
                </div>
              </div>

              {apiError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {apiError}
                </div>
              )}

              <button
                onClick={handleContinueInfo}
                disabled={submitting || !fullName || !email}
                className="w-full py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors mt-2 disabled:opacity-50"
              >
                {submitting ? '...' : tc('continue')}
              </button>
            </div>
          )}

          {/* Step 2: Payout Setup */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="bg-accent rounded-xl p-4 border border-gray-200">
                <p className="text-sm font-semibold text-gray-900 mb-1">{t('paymentMethod')}</p>
                <p className="text-xs text-gray-500 mb-3">{t('step2Desc')}</p>

                <div className="grid grid-cols-3 gap-2 mb-4">
                  <button
                    type="button"
                    onClick={() => { setPaymentMethod('stripe'); setApiError('') }}
                    className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border-2 text-xs font-semibold transition-colors ${
                      paymentMethod === 'stripe'
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" />
                    </svg>
                    Stripe
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPaymentMethod('paypal'); setApiError('') }}
                    className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border-2 text-xs font-semibold transition-colors ${
                      paymentMethod === 'paypal'
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106zm14.146-14.42a3.35 3.35 0 0 0-.607-.541c-.013.076-.026.175-.041.254-.59 3.025-2.566 5.517-6.86 5.517h-1.91l-.903 5.733h4.726c.459 0 .85-.334.922-.788.038-.236.785-4.982.857-5.442.072-.459.458-.788.917-.788h.577c3.735 0 6.662-1.519 7.518-5.918.357-1.839.174-3.37-.774-4.45z" />
                    </svg>
                    {t('paypal')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPaymentMethod('bank'); setApiError('') }}
                    className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border-2 text-xs font-semibold transition-colors ${
                      paymentMethod === 'bank'
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3" />
                    </svg>
                    {t('bankTransfer')}
                  </button>
                </div>

                {apiError && (
                  <div className="p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 mb-3">
                    {apiError}
                  </div>
                )}

                {paymentMethod === 'stripe' && (
                  <div className="flex items-center gap-2 text-xs text-gray-600 bg-white border border-gray-200 rounded-lg p-3">
                    <svg className="w-4 h-4 text-[#635bff] flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" />
                    </svg>
                    <span>Stripe onboarding will open in a new tab after you continue.</span>
                  </div>
                )}

                {paymentMethod === 'paypal' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1.5">{t('paypalEmail')}</label>
                    <input
                      type="email"
                      value={paypalEmail}
                      onChange={(e) => setPaypalEmail(e.target.value)}
                      placeholder="you@paypal.com"
                      className="w-full px-3 py-2.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                )}

                {paymentMethod === 'bank' && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1.5">{t('accountHolder')}</label>
                      <input
                        type="text"
                        value={bankAccountHolder}
                        onChange={(e) => setBankAccountHolder(e.target.value)}
                        placeholder="John Doe"
                        className="w-full px-3 py-2.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1.5">{t('iban')}</label>
                      <input
                        type="text"
                        value={bankIban}
                        onChange={(e) => setBankIban(e.target.value.toUpperCase())}
                        placeholder="DE89 3704 0044 0532 0130 00"
                        className="w-full px-3 py-2.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1.5">{t('swiftBic')}</label>
                        <input
                          type="text"
                          value={bankSwiftBic}
                          onChange={(e) => setBankSwiftBic(e.target.value.toUpperCase())}
                          placeholder="DEUTDEFF"
                          className="w-full px-3 py-2.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1.5">{t('bankCountry')}</label>
                        <input
                          type="text"
                          value={bankCountry}
                          onChange={(e) => setBankCountry(e.target.value.toUpperCase().slice(0, 2))}
                          placeholder="DE"
                          maxLength={2}
                          className="w-full px-3 py-2.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-900 font-mono uppercase focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1.5">{t('bankName')}</label>
                      <input
                        type="text"
                        value={bankName}
                        onChange={(e) => setBankName(e.target.value)}
                        placeholder="Deutsche Bank"
                        className="w-full px-3 py-2.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                      />
                    </div>
                  </div>
                )}
              </div>

              <p className="text-sm text-gray-600 text-center" dangerouslySetInnerHTML={{ __html: t.raw('commissionInfo') }} />

              <p className="text-sm text-gray-500 text-center" dangerouslySetInnerHTML={{ __html: (t.raw('pendingReview') as string).replace('{email}', email || 'your email') }} />

              <div className="flex gap-2">
                <button
                  onClick={() => { setApiError(''); setStep(1) }}
                  disabled={submitting}
                  className="px-5 py-3 bg-white text-gray-700 font-semibold rounded-xl border border-gray-200 hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  {tc('back')}
                </button>
                <button
                  onClick={handleSubmitPayout}
                  disabled={submitting}
                  className="flex-1 py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors disabled:opacity-50"
                >
                  {submitting ? '...' : tc('continue')}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Your Referral Link */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="bg-accent rounded-xl p-4 border border-gray-200">
                <p className="flex items-center gap-2 text-sm font-medium text-primary-700 mb-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  {t('yourReferralLink')}
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={`${referralDomain}?ref=${referralCode}`}
                    className="flex-1 px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 font-mono"
                  />
                  <button
                    onClick={handleCopy}
                    className="p-2 rounded-lg border border-gray-300 hover:bg-gray-100 transition-colors"
                    title="Copy link"
                  >
                    {copied ? (
                      <svg className="w-5 h-5 text-success-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              <p className="text-sm text-gray-600 text-center" dangerouslySetInnerHTML={{ __html: t.raw('commissionInfo') }} />

              <button
                onClick={() => { onClose(); reset() }}
                className="w-full py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors"
              >
                {tc('done')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
