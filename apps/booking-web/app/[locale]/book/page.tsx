'use client'

import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import Image from 'next/image'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import { useHotel, useRooms, useAddons, useSlug } from '@/contexts/HotelContext'
import { calculateNights, formatDate } from '@/lib/utils'
import { useCurrency } from '@/contexts/CurrencyContext'

const COUNTRIES = [
  'Austria', 'Germany', 'Switzerland', 'United States', 'United Kingdom',
  'France', 'Italy', 'Netherlands', 'Spain', 'Australia', 'Canada', 'Japan',
]

function BookPageContent() {
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations('book')
  const tc = useTranslations('common')
  const ts = useTranslations('steps')
  const { hotel } = useHotel()
  const { rooms } = useRooms()
  const { addons } = useAddons()
  const { formatPrice } = useCurrency()
  const searchParams = useSearchParams()
  const roomId = searchParams.get('room') || ''
  const checkIn = searchParams.get('checkIn') || '2026-02-13'
  const checkOut = searchParams.get('checkOut') || '2026-02-18'
  const adultsParam = parseInt(searchParams.get('adults') || '2')
  const childrenParam = parseInt(searchParams.get('children') || '0')
  const rateType = searchParams.get('rateType') || 'flexible'

  const hasAddons = addons.length > 0
  const STEPS = hasAddons
    ? [
        { number: 1, label: ts('rooms') },
        { number: 2, label: ts('addons') },
        { number: 3, label: ts('details') },
        { number: 4, label: ts('payment') },
      ]
    : [
        { number: 1, label: ts('rooms') },
        { number: 2, label: ts('details') },
        { number: 3, label: ts('payment') },
      ]
  const currentStep = hasAddons ? 3 : 2

  const room = rooms.find((r) => r.id === roomId) || rooms[0]
  const nights = calculateNights(checkIn, checkOut)
  const nightlyRate = rateType === 'nonrefundable'
    ? (room?.nonRefundableRate ?? Math.round(room.baseRate * 0.85))
    : room?.baseRate ?? 0
  const roomTotal = room ? nightlyRate * nights : 0

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [specialRequests, setSpecialRequests] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!firstName || !lastName || !email || !phone) {
      setError(t('fillRequired'))
      return
    }
    if (!room) {
      setError('No room selected')
      return
    }

    setSubmitting(true)
    setError('')

    try {
      // Read referral cookie if present
      const refCookie = document.cookie.match(/(^| )ref=([^;]+)/)
      const referralCode = refCookie ? decodeURIComponent(refCookie[2]) : undefined

      // Store guest details in sessionStorage for the payment page
      sessionStorage.setItem('guestDetails', JSON.stringify({
        roomTypeId: room.id,
        guestFirstName: firstName,
        guestLastName: lastName,
        guestEmail: email,
        guestPhone: phone,
        specialRequests,
        referralCode,
      }))

      // Redirect to payment page with booking params
      const params = new URLSearchParams({
        room: room.id,
        checkIn,
        checkOut,
        adults: String(adultsParam),
        children: String(childrenParam),
        rateType,
      })
      router.push(`/payment?${params.toString()}`)
    } catch (err: any) {
      setError(err.message || 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  if (!room) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">No room selected. Please go back and select a room.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero */}
      <div className="relative h-[420px] w-full">
        <Image
          src={hotel.heroImage}
          alt={hotel.name}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />
        <BookingNavigation />
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-heading italic text-white mb-4">
            {hotel.name}
          </h1>
          <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed">
            {hotel.description}
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-10 gap-4">
          <h2 className="text-3xl font-heading text-gray-900">{t('guestInformation')}</h2>

          <div className="flex items-center gap-2 flex-shrink-0">
            {STEPS.map((step, index) => (
              <div key={step.number} className="flex items-center">
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      step.number === currentStep
                        ? 'bg-primary-600 text-white'
                        : step.number < currentStep
                        ? 'bg-primary-600 text-white'
                        : 'bg-gray-200 text-gray-500'
                    }`}
                  >
                    {step.number < currentStep ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      step.number
                    )}
                  </div>
                  <span className={`text-sm font-medium ${step.number <= currentStep ? 'text-gray-900' : 'text-gray-400'}`}>
                    {step.label}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <div className={`w-8 md:w-12 h-px mx-2 ${step.number < currentStep ? 'bg-primary-600' : 'bg-gray-300'}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Booking Summary Card */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h3 className="text-lg font-bold text-gray-900 mb-5">{t('bookingSummary')}</h3>

              {/* Room row */}
              <div className="flex items-start gap-4 pb-5 border-b border-gray-100">
                <div className="relative w-16 h-16 rounded-xl overflow-hidden flex-shrink-0">
                  <Image src={room.images[0]} alt={room.name} fill className="object-cover" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-gray-900">{room.name}</p>
                  <p className="text-sm text-gray-500">
                    {formatDate(checkIn, locale)} - {formatDate(checkOut, locale)} &middot; {tc('nights', { count: nights })}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-gray-900">{formatPrice(roomTotal, room.currency)}</p>
                  <p className="text-xs text-gray-500">{formatPrice(nightlyRate, room.currency)} &times; {nights}</p>
                </div>
              </div>

              {/* Total */}
              <div className="flex items-center justify-between pt-4">
                <p className="text-base font-bold text-gray-900">{tc('total')}</p>
                <div className="text-right">
                  <p className="text-xl font-bold text-gray-900">{formatPrice(roomTotal, room.currency)}</p>
                  <p className="text-xs text-gray-500">{tc('includesTaxes')}</p>
                </div>
              </div>
            </div>

            {/* Guest Form Card */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <p className="text-gray-600 mb-6">{t('pleaseProvide')}</p>

              <div className="space-y-5">
                {/* First + Last Name */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      {t('firstName')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder="John"
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      {t('lastName')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder="Doe"
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                </div>

                {/* Email */}
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                    {t('emailAddress')} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="john.doe@example.com"
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                  />
                </div>

                {/* Phone + Country */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      {t('phoneNumber')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+1 234 567 8900"
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      {t('country')}
                    </label>
                    <select className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:1.25rem] bg-[right_0.75rem_center] bg-no-repeat">
                      <option value="">{t('selectCountry')}</option>
                      {COUNTRIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Special Requests */}
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                    {t('specialRequests')}
                  </label>
                  <textarea
                    rows={4}
                    value={specialRequests}
                    onChange={(e) => setSpecialRequests(e.target.value)}
                    placeholder={t('specialRequestsPlaceholder')}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400 resize-y"
                  />
                </div>
              </div>
            </div>

            {/* Bottom Action Bar */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => router.push('/')}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                {t('backToRooms') || 'Back to rooms'}
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-8 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm disabled:opacity-50"
              >
                {submitting ? t('booking') || 'Processing...' : t('continueToPayment') || 'Continue to Payment'}
              </button>
            </div>
          </div>

          {/* Right Sidebar — Your Stay */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl border border-gray-200 p-6 sticky top-8">
              <h3 className="text-lg font-bold text-gray-900 mb-5">{t('yourStay')}</h3>

              {/* Stay details */}
              <div className="space-y-3 pb-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('roomLabel')}</span>
                  <span className="font-semibold text-gray-900 text-right">{room.name}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('checkIn')}</span>
                  <span className="font-semibold text-gray-900">{formatDate(checkIn, locale)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('checkOut')}</span>
                  <span className="font-semibold text-gray-900">{formatDate(checkOut, locale)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('duration')}</span>
                  <span className="font-semibold text-gray-900">{tc('nights', { count: nights })}</span>
                </div>
              </div>

              {/* Price breakdown */}
              <div className="space-y-3 py-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('roomLabel')} ({tc('nights', { count: nights })})</span>
                  <span className="font-semibold text-gray-900">{formatPrice(roomTotal, room.currency)}</span>
                </div>
              </div>

              {/* Total */}
              <div className="pt-5">
                <div className="flex justify-between items-start">
                  <span className="text-base font-bold text-gray-900">{tc('total')}</span>
                  <div className="text-right">
                    <p className="text-xl font-bold text-gray-900">{formatPrice(roomTotal, room.currency)}</p>
                    <p className="text-xs text-gray-500">{tc('includesTaxes')}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <BookingFooter />
    </div>
  )
}

export default function BookPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <BookPageContent />
    </Suspense>
  )
}
