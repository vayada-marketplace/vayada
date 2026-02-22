'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import { useHotel } from '@/contexts/HotelContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useTranslations, useLocale } from 'next-intl'
import { useRouter, usePathname } from '@/i18n/navigation'

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'id', label: 'Indonesia' },
] as const

const CURRENCY_LABELS: Record<string, string> = {
  USD: '$ US Dollar',
  EUR: '\u20AC Euro',
  GBP: '\u00A3 British Pound',
  IDR: 'Rp Indonesian Rupiah',
  AUD: 'A$ Australian Dollar',
  CHF: 'CHF Swiss Franc',
  JPY: '\u00A5 Japanese Yen',
  CAD: 'C$ Canadian Dollar',
  CNY: '\u00A5 Chinese Yuan',
  SEK: 'kr Swedish Krona',
  NOK: 'kr Norwegian Krone',
  DKK: 'kr Danish Krone',
  SGD: 'S$ Singapore Dollar',
  HKD: 'HK$ Hong Kong Dollar',
  THB: '\u0E3F Thai Baht',
  MYR: 'RM Malaysian Ringgit',
  NZD: 'NZ$ New Zealand Dollar',
  ZAR: 'R South African Rand',
  BRL: 'R$ Brazilian Real',
  INR: '\u20B9 Indian Rupee',
  KRW: '\u20A9 South Korean Won',
  MXN: 'MX$ Mexican Peso',
  TRY: '\u20BA Turkish Lira',
  PLN: 'z\u0142 Polish Zloty',
  CZK: 'K\u010D Czech Koruna',
  HUF: 'Ft Hungarian Forint',
  ILS: '\u20AA Israeli Shekel',
  PHP: '\u20B1 Philippine Peso',
  TWD: 'NT$ Taiwan Dollar',
  ISK: 'kr Icelandic Krona',
  BGN: '\u043B\u0432 Bulgarian Lev',
  RON: 'lei Romanian Leu',
  HRK: 'kn Croatian Kuna',
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    const listener = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return
      handler()
    }
    document.addEventListener('mousedown', listener)
    return () => document.removeEventListener('mousedown', listener)
  }, [ref, handler])
}

// --- Contact Popover ---
function ContactPopover({ open, onClose, phone, whatsapp, email }: { open: boolean; onClose: () => void; phone: string; whatsapp?: string; email: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const t = useTranslations('nav')
  useClickOutside(ref, onClose)
  if (!open) return null

  const phoneDigits = phone.replace(/\s+/g, '')
  const whatsappDigits = (whatsapp || phone).replace(/\s+/g, '')

  return (
    <div ref={ref} className="absolute right-0 top-full mt-2 w-64 bg-white rounded-xl shadow-xl border border-gray-100 py-2 z-50">
      <a href={`tel:${phoneDigits}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
        <div className="w-8 h-8 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
          <svg className="w-4 h-4 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-gray-900">{t('phone')}</p>
          <p className="text-xs text-gray-500">{phone}</p>
        </div>
      </a>
      <a href={`https://wa.me/${whatsappDigits}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
        <div className="w-8 h-8 rounded-full bg-success-50 flex items-center justify-center flex-shrink-0">
          <svg className="w-4 h-4 text-success-600" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.198-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-gray-900">{t('whatsapp')}</p>
          <p className="text-xs text-gray-500">{whatsapp || phone}</p>
        </div>
      </a>
      <a href={`mailto:${email}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
        <div className="w-8 h-8 rounded-full bg-info-50 flex items-center justify-center flex-shrink-0">
          <svg className="w-4 h-4 text-info-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-gray-900">{t('email')}</p>
          <p className="text-xs text-gray-500">{email}</p>
        </div>
      </a>
    </div>
  )
}

// --- Refer a Guest Modal (3 steps) ---
const PMS_URL = process.env.NEXT_PUBLIC_PMS_URL || ''

function ReferModal({ open, onClose, hotelSlug }: { open: boolean; onClose: () => void; hotelSlug: string }) {
  const t = useTranslations('refer')
  const tc = useTranslations('common')
  const [step, setStep] = useState(1)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [social, setSocial] = useState('')
  const [userType, setUserType] = useState<'guest' | 'creator'>('guest')
  const [paymentMethod, setPaymentMethod] = useState<'paypal' | 'bank'>('paypal')
  const [paypalEmail, setPaypalEmail] = useState('')
  const [bankIban, setBankIban] = useState('')
  const [copied, setCopied] = useState(false)
  const [referralCode, setReferralCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState('')

  const referralDomain = `${hotelSlug}.booking.vayada.com`

  const handleGenerateLink = async () => {
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
          paypalEmail,
          bankIban,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Registration failed' }))
        throw new Error(err.detail || 'Registration failed')
      }
      const data = await res.json()
      setReferralCode(data.referralCode)
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
    setPaymentMethod('paypal')
    setPaypalEmail('')
    setBankIban('')
    setCopied(false)
    setReferralCode('')
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
                  s < step
                    ? 'bg-primary-600 border-primary-600 text-white'
                    : s === step
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
          {/* Step 1: Info */}
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

              <button
                onClick={() => setStep(2)}
                className="w-full py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors mt-2"
              >
                {tc('continue')}
              </button>
            </div>
          )}

          {/* Step 2: Payment */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-bold text-gray-900 mb-2">{t('paymentMethod')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setPaymentMethod('paypal')}
                    className={`py-3 rounded-xl border-2 text-sm font-semibold transition-colors ${
                      paymentMethod === 'paypal'
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {t('paypal')}
                  </button>
                  <button
                    onClick={() => setPaymentMethod('bank')}
                    className={`py-3 rounded-xl border-2 text-sm font-semibold transition-colors ${
                      paymentMethod === 'bank'
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {t('bankTransfer')}
                  </button>
                </div>
              </div>

              {paymentMethod === 'paypal' && (
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1.5">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    {t('paypalEmail')}
                  </label>
                  <input
                    type="email"
                    value={paypalEmail}
                    onChange={(e) => setPaypalEmail(e.target.value)}
                    placeholder="paypal@example.com"
                    className="w-full px-4 py-3 rounded-xl border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                  />
                </div>
              )}

              {paymentMethod === 'bank' && (
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1.5">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                    {t('iban')}
                  </label>
                  <input
                    type="text"
                    value={bankIban}
                    onChange={(e) => setBankIban(e.target.value)}
                    placeholder="AT89 3704 0044 0532 0130 00"
                    className="w-full px-4 py-3 rounded-xl border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                  />
                </div>
              )}

              {apiError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {apiError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setStep(1)}
                  disabled={submitting}
                  className="flex-1 py-3 border border-gray-300 text-gray-700 font-semibold rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  {tc('back')}
                </button>
                <button
                  onClick={handleGenerateLink}
                  disabled={submitting}
                  className="flex-1 py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors disabled:opacity-50"
                >
                  {submitting ? '...' : t('generateLink')}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Link */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
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

              <p className="text-sm text-gray-500 text-center" dangerouslySetInnerHTML={{ __html: (t.raw('pendingReview') as string).replace('{email}', email || 'your email') }} />

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

// --- Dropdown (for Language & Currency) ---
function Dropdown({
  open,
  onClose,
  items,
  selected,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  items: { value: string; label: string }[]
  selected: string
  onSelect: (value: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, onClose)
  if (!open) return null

  return (
    <div ref={ref} className="absolute right-0 top-full mt-2 w-52 bg-white rounded-xl shadow-xl border border-gray-100 py-1 z-50">
      {items.map((item) => (
        <button
          key={item.value}
          onClick={() => { onSelect(item.value); onClose() }}
          className={`w-full flex items-center justify-between px-4 py-2.5 text-sm transition-colors ${
            selected === item.value
              ? 'bg-primary-50 text-primary-700 font-medium'
              : 'text-gray-700 hover:bg-gray-50'
          }`}
        >
          {item.label}
          {selected === item.value && (
            <svg className="w-4 h-4 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>
      ))}
    </div>
  )
}

// --- Main Navigation ---
export default function BookingNavigation() {
  const { hotel } = useHotel()
  const { selectedCurrency, setSelectedCurrency } = useCurrency()
  const t = useTranslations('nav')
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [referOpen, setReferOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)
  const [currOpen, setCurrOpen] = useState(false)

  const selectedLangLabel = LANGUAGES.find((l) => l.code === locale)?.label.slice(0, 2).toUpperCase() || 'EN'

  const currencyItems = useMemo(() => {
    const codes = [hotel.currency, ...(hotel.supportedCurrencies || []).filter((c: string) => c !== hotel.currency)]
    return codes.map((code: string) => ({
      value: code,
      label: CURRENCY_LABELS[code] || code,
    }))
  }, [hotel.currency, hotel.supportedCurrencies])

  const closeAll = () => {
    setContactOpen(false)
    setLangOpen(false)
    setCurrOpen(false)
  }

  const handleLanguageChange = (newLocale: string) => {
    router.replace(pathname, { locale: newLocale as 'en' | 'de' | 'fr' | 'es' | 'id' })
  }

  return (
    <>
      <nav className="absolute top-0 left-0 right-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Left - Hotel Name */}
            <a href="/" className="flex items-center gap-2">
              <span className="text-lg font-semibold text-white">{hotel.name}</span>
            </a>

            {/* Right - Actions */}
            <div className="hidden md:flex items-center gap-2">
              {/* Contact */}
              <div className="relative">
                <button
                  onClick={() => { closeAll(); setContactOpen(!contactOpen) }}
                  className="px-5 py-2 text-sm font-semibold text-white bg-primary-600 rounded-full hover:bg-primary-700 transition-colors"
                >
                  {t('contact')}
                </button>
                <ContactPopover
                  open={contactOpen}
                  onClose={() => setContactOpen(false)}
                  phone={hotel.contact.phone}
                  whatsapp={hotel.contact.whatsapp}
                  email={hotel.contact.email}
                />
              </div>

              {/* Refer a Guest */}
              <button
                onClick={() => setReferOpen(true)}
                className="px-5 py-2 text-sm font-semibold text-white border-2 border-white/60 rounded-full hover:bg-white/10 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
                {t('referGuest')}
              </button>

              {/* Language */}
              <div className="relative">
                <button
                  onClick={() => { closeAll(); setLangOpen(!langOpen) }}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white border-2 border-white/60 rounded-full hover:bg-white/10 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                  </svg>
                  {selectedLangLabel}
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <Dropdown
                  open={langOpen}
                  onClose={() => setLangOpen(false)}
                  items={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
                  selected={locale}
                  onSelect={handleLanguageChange}
                />
              </div>

              {/* Currency */}
              {currencyItems.length > 1 && (
                <div className="relative">
                  <button
                    onClick={() => { closeAll(); setCurrOpen(!currOpen) }}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white border-2 border-white/60 rounded-full hover:bg-white/10 transition-colors"
                  >
                    {selectedCurrency}
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  <Dropdown
                    open={currOpen}
                    onClose={() => setCurrOpen(false)}
                    items={currencyItems}
                    selected={selectedCurrency}
                    onSelect={setSelectedCurrency}
                  />
                </div>
              )}
            </div>

            {/* Mobile Menu Button */}
            <button
              className="md:hidden text-white"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile Menu */}
        {isMenuOpen && (
          <div className="md:hidden bg-black/80 backdrop-blur-md border-t border-white/10">
            <div className="px-4 py-4 space-y-3">
              <button
                onClick={() => { setContactOpen(!contactOpen); setIsMenuOpen(false) }}
                className="block w-full text-left text-white hover:text-white/80 py-2 font-medium"
              >
                {t('contact')}
              </button>
              <button
                onClick={() => { setReferOpen(true); setIsMenuOpen(false) }}
                className="block w-full text-left text-white hover:text-white/80 py-2 font-medium"
              >
                {t('referGuest')}
              </button>
            </div>
          </div>
        )}
      </nav>

      {/* Refer Modal (rendered outside nav for z-index) */}
      <ReferModal open={referOpen} onClose={() => setReferOpen(false)} hotelSlug={hotel.slug} />
    </>
  )
}
