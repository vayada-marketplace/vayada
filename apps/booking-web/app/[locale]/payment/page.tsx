'use client'

import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter, Link } from '@/i18n/navigation'
import Image from 'next/image'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import { useHotel, useRooms } from '@/contexts/HotelContext'
import { calculateNights, formatDate } from '@/lib/utils'
import { useCurrency } from '@/contexts/CurrencyContext'

function PaymentPageContent() {
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations('payment')
  const tc = useTranslations('common')
  const ts = useTranslations('steps')
  const tb = useTranslations('book')
  const { hotel } = useHotel()
  const { rooms } = useRooms()
  const { formatPrice } = useCurrency()
  const searchParams = useSearchParams()
  const roomId = searchParams.get('room') || 'room-2'
  const checkIn = searchParams.get('checkIn') || '2026-02-13'
  const checkOut = searchParams.get('checkOut') || '2026-02-18'
  const currentStep = 4

  const STEPS = [
    { number: 1, label: ts('rooms') },
    { number: 2, label: ts('addons') },
    { number: 3, label: ts('details') },
    { number: 4, label: ts('payment') },
  ]

  const room = rooms.find((r) => r.id === roomId) || rooms[1]
  const nights = calculateNights(checkIn, checkOut)
  const roomTotal = room.baseRate * nights
  const addonsTotal = 80
  const total = roomTotal + addonsTotal

  const [agreedToTerms, setAgreedToTerms] = useState(false)

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
          <h2 className="text-3xl font-heading text-gray-900">{t('securePayment')}</h2>

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

        {/* Guest confirmation banner */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="text-base font-bold text-gray-900">John Doe</p>
            <p className="text-sm text-gray-500">john.doe@example.com</p>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-primary-600 font-medium">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {t('detailsConfirmed')}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Payment Details Card */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="flex items-center gap-2.5 mb-6">
                <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
                <h3 className="text-lg font-bold text-gray-900">{t('paymentDetails')}</h3>
              </div>

              <div className="space-y-5">
                {/* Cardholder Name */}
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">{t('cardholderName')}</label>
                  <input
                    type="text"
                    placeholder={t('nameOnCard')}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                  />
                </div>

                {/* Card Number */}
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">{t('cardNumber')}</label>
                  <input
                    type="text"
                    placeholder={t('cardPlaceholder')}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                  />
                </div>

                {/* Expiry + CVC */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">{t('expiryDate')}</label>
                    <input
                      type="text"
                      placeholder={t('expiryPlaceholder')}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">{t('cvc')}</label>
                    <input
                      type="text"
                      placeholder={t('cvcPlaceholder')}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                </div>
              </div>

              {/* Security badges */}
              <div className="flex items-center gap-4 mt-5 pt-5 border-t border-gray-100">
                <div className="flex items-center gap-1.5 text-sm text-gray-500">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  {t('sslEncrypted')}
                </div>
                <div className="flex items-center gap-1.5 text-sm text-gray-500">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  {t('securePaymentBadge')}
                </div>
              </div>
            </div>

            {/* Terms Agreement */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <label className="flex items-start gap-3 cursor-pointer">
                <button
                  onClick={() => setAgreedToTerms(!agreedToTerms)}
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors ${
                    agreedToTerms ? 'bg-primary-600 border-primary-600' : 'border-gray-300'
                  }`}
                >
                  {agreedToTerms && (
                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
                <span className="text-sm text-gray-700 leading-relaxed">
                  {t.rich('agreeTerms', {
                    terms: (chunks) => <a href="#" className="text-primary-600 underline font-medium">{t('termsAndConditions')}</a>,
                    cancellation: (chunks) => <a href="#" className="text-primary-600 underline font-medium">{t('cancellationPolicy')}</a>,
                    amount: formatPrice(total, room.currency),
                  })}
                </span>
              </label>
            </div>

            {/* Cancellation Policy */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h3 className="text-base font-bold text-gray-900 mb-2">{t('cancellationPolicyTitle')}</h3>
              <p className="text-sm text-gray-600">
                {t('cancellationPolicyDesc', { date: formatDate(checkIn, locale) })}
              </p>
            </div>

            {/* Back button */}
            <div className="pt-2">
              <button
                onClick={() => router.push('/book')}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1 transition-colors border border-gray-300 rounded-full px-5 py-2.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                {t('backToDetails')}
              </button>
            </div>
          </div>

          {/* Right Sidebar — Order Summary */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl border border-gray-200 p-6 sticky top-8">
              <h3 className="text-lg font-bold text-gray-900 mb-5">{t('orderSummary')}</h3>

              {/* Room info */}
              <div className="flex items-center gap-3 pb-5 border-b border-gray-100">
                <div className="relative w-14 h-14 rounded-xl overflow-hidden flex-shrink-0">
                  <Image src={room.images[0]} alt={room.name} fill className="object-cover" />
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900">{room.name}</p>
                  <p className="text-xs text-gray-500">{tb('flexibleRate')}</p>
                </div>
              </div>

              {/* Stay details */}
              <div className="space-y-3 py-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{tb('checkIn')}</span>
                  <span className="font-semibold text-gray-900">{formatDate(checkIn, locale)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{tb('checkOut')}</span>
                  <span className="font-semibold text-gray-900">{formatDate(checkOut, locale)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{tb('duration')}</span>
                  <span className="font-semibold text-gray-900">{tc('nights', { count: nights })}</span>
                </div>
              </div>

              {/* Price breakdown */}
              <div className="space-y-3 py-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{ts('rooms')} ({tc('nights', { count: nights })})</span>
                  <span className="font-semibold text-gray-900">{formatPrice(roomTotal, room.currency)}</span>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">{t('addonsLabel')}</p>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500 pl-2">{t('airportTransfer')}</span>
                    <span className="font-semibold text-gray-900">{formatPrice(addonsTotal, room.currency)}</span>
                  </div>
                </div>
              </div>

              {/* Total */}
              <div className="pt-5 mb-5">
                <div className="flex justify-between items-start">
                  <span className="text-base font-bold text-gray-900">{tc('total')}</span>
                  <div className="text-right">
                    <p className="text-xl font-bold text-gray-900">{formatPrice(total, room.currency)}</p>
                    <p className="text-xs text-gray-500">{tc('includesTaxes')}</p>
                  </div>
                </div>
              </div>

              {/* Pay button */}
              <Link
                href="/booking/VBK-A1B2C3"
                className={`block w-full py-3 text-center font-semibold rounded-lg transition-colors text-sm ${
                  agreedToTerms
                    ? 'bg-primary-600 text-white hover:bg-primary-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed pointer-events-none'
                }`}
              >
                {t('pay', { amount: formatPrice(total, room.currency) })}
              </Link>
              <p className="text-xs text-gray-500 text-center mt-2">{t('paymentSecure')}</p>
            </div>
          </div>
        </div>
      </div>

      <BookingFooter />
    </div>
  )
}

export default function PaymentPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <PaymentPageContent />
    </Suspense>
  )
}
