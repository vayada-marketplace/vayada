'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import Image from 'next/image'
import { useStripe, useElements, PaymentElement } from '@stripe/react-stripe-js'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import StripeProvider from '@/components/StripeProvider'
import { useHotel, useRooms, useSlug } from '@/contexts/HotelContext'
import { calculateNights, formatDate } from '@/lib/utils'
import { useCurrency } from '@/contexts/CurrencyContext'
import { bookingService } from '@/services/api/booking'

interface GuestDetails {
  roomTypeId: string
  guestFirstName: string
  guestLastName: string
  guestEmail: string
  guestPhone: string
  specialRequests: string
  referralCode?: string
}

function CardPaymentForm({
  onSubmit,
  submitting,
  agreedToTerms,
  buttonLabel,
}: {
  onSubmit: () => void
  submitting: boolean
  agreedToTerms: boolean
  buttonLabel: string
}) {
  const stripe = useStripe()
  const elements = useElements()

  return (
    <div className="space-y-5">
      <PaymentElement />
      <div className="flex items-center gap-4 mt-5 pt-5 border-t border-gray-100">
        <div className="flex items-center gap-1.5 text-sm text-gray-500">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          SSL Encrypted
        </div>
        <div className="flex items-center gap-1.5 text-sm text-gray-500">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          Secure Payment
        </div>
      </div>
    </div>
  )
}

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
  const { slug } = useSlug()
  const searchParams = useSearchParams()

  const roomId = searchParams.get('room') || ''
  const checkIn = searchParams.get('checkIn') || ''
  const checkOut = searchParams.get('checkOut') || ''
  const adultsParam = parseInt(searchParams.get('adults') || '2')
  const childrenParam = parseInt(searchParams.get('children') || '0')
  const currentStep = 4

  const STEPS = [
    { number: 1, label: ts('rooms') },
    { number: 2, label: ts('addons') },
    { number: 3, label: ts('details') },
    { number: 4, label: ts('payment') },
  ]

  const room = rooms.find((r) => r.id === roomId) || rooms[0]
  const nights = calculateNights(checkIn, checkOut)
  const roomTotal = room ? room.baseRate * nights : 0

  const [guestDetails, setGuestDetails] = useState<GuestDetails | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'pay_at_property'>('card')
  const [payAtPropertyEnabled, setPayAtPropertyEnabled] = useState(false)
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [bookingReference, setBookingReference] = useState<string | null>(null)

  // Load guest details from sessionStorage
  useEffect(() => {
    const stored = sessionStorage.getItem('guestDetails')
    if (stored) {
      try {
        setGuestDetails(JSON.parse(stored))
      } catch {
        router.push('/book')
      }
    } else {
      router.push('/book')
    }
  }, [router])

  // Check if pay-at-property is enabled
  useEffect(() => {
    if (slug) {
      bookingService.getPaymentSettings(slug).then((settings) => {
        setPayAtPropertyEnabled(settings.payAtPropertyEnabled)
      })
    }
  }, [slug])

  const handleSubmit = async () => {
    if (!agreedToTerms || !guestDetails || !room) return

    setSubmitting(true)
    setError('')

    try {
      const result = await bookingService.create(slug, {
        ...guestDetails,
        checkIn,
        checkOut,
        adults: adultsParam,
        children: childrenParam,
        paymentMethod,
      })

      const booking = result.booking
      setBookingId(booking.id)
      setBookingReference(booking.bookingReference)

      if (paymentMethod === 'card' && result.clientSecret) {
        setClientSecret(result.clientSecret)
        // The Stripe form will be rendered, user confirms payment there
      } else {
        // Pay at property — redirect to confirmation
        sessionStorage.setItem('lastBooking', JSON.stringify(booking))
        router.push(`/booking/${booking.bookingReference}`)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create booking')
      setSubmitting(false)
    }
  }

  if (!guestDetails || !room) {
    return <div className="min-h-screen bg-gray-50" />
  }

  // If we have a client secret, render the Stripe payment form
  if (clientSecret && bookingId) {
    return (
      <StripeProvider clientSecret={clientSecret}>
        <StripePaymentPage
          hotel={hotel}
          room={room}
          checkIn={checkIn}
          checkOut={checkOut}
          nights={nights}
          adults={adultsParam}
          children={childrenParam}
          roomTotal={roomTotal}
          guestDetails={guestDetails}
          bookingId={bookingId}
          bookingReference={bookingReference!}
          slug={slug}
          formatPrice={formatPrice}
          formatDate={formatDate}
          locale={locale}
        />
      </StripeProvider>
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
            <p className="text-base font-bold text-gray-900">{guestDetails.guestFirstName} {guestDetails.guestLastName}</p>
            <p className="text-sm text-gray-500">{guestDetails.guestEmail}</p>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-primary-600 font-medium">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {t('detailsConfirmed')}
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
            {/* Payment Method Selection */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="flex items-center gap-2.5 mb-6">
                <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
                <h3 className="text-lg font-bold text-gray-900">{t('paymentDetails')}</h3>
              </div>

              {/* Payment method tabs */}
              <div className="flex gap-3 mb-6">
                <button
                  onClick={() => setPaymentMethod('card')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-colors text-left ${
                    paymentMethod === 'card'
                      ? 'border-primary-600 bg-primary-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                    <span className="font-semibold text-sm text-gray-900">{t('payWithCard') || 'Pay with Card'}</span>
                  </div>
                  <p className="text-xs text-gray-500">{t('cardAuthNote') || 'An authorization hold will be placed on your card'}</p>
                </button>
                {payAtPropertyEnabled && (
                  <button
                    onClick={() => setPaymentMethod('pay_at_property')}
                    className={`flex-1 p-4 rounded-xl border-2 transition-colors text-left ${
                      paymentMethod === 'pay_at_property'
                        ? 'border-primary-600 bg-primary-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                      </svg>
                      <span className="font-semibold text-sm text-gray-900">{t('payAtProperty') || 'Pay at Property'}</span>
                    </div>
                    <p className="text-xs text-gray-500">{t('payAtPropertyNote') || 'Pay when you arrive at the hotel'}</p>
                  </button>
                )}
              </div>

              {/* Card info note or property info */}
              {paymentMethod === 'card' ? (
                <div className="space-y-3">
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700">
                    {t('cardAuthExplanation') || 'Your card will be authorized but not charged until the host accepts your booking. The hold will be released if the booking is declined or expires.'}
                  </div>
                  <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-xl text-sm text-gray-600">
                    <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                    {t('cardNextStep') || 'You will enter your card details in the next step.'}
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
                  {t('payAtPropertyExplanation') || 'No payment is required now. You will pay directly at the property upon check-in. The host will review your booking request.'}
                </div>
              )}
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
                    amount: formatPrice(roomTotal, room?.currency || 'EUR'),
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

            {/* Action buttons */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => router.push('/book')}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1 transition-colors border border-gray-300 rounded-full px-5 py-2.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                {t('backToDetails')}
              </button>
              <button
                onClick={handleSubmit}
                disabled={!agreedToTerms || submitting}
                className={`px-8 py-3 font-semibold rounded-full transition-colors text-sm flex items-center gap-2 ${
                  agreedToTerms && !submitting
                    ? 'bg-primary-600 text-white hover:bg-primary-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                {submitting ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    {t('processing') || 'Processing...'}
                  </>
                ) : paymentMethod === 'card' ? (
                  <>
                    {t('continueToPayment') || 'Continue to Payment'}
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </>
                ) : (
                  t('submitRequest') || 'Submit Booking Request'
                )}
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

/** Stripe payment confirmation page — rendered inside Elements provider */
function StripePaymentPage({
  hotel,
  room,
  checkIn,
  checkOut,
  nights,
  adults,
  children,
  roomTotal,
  guestDetails,
  bookingId,
  bookingReference,
  slug,
  formatPrice,
  formatDate,
  locale,
}: any) {
  const stripe = useStripe()
  const elements = useElements()
  const router = useRouter()
  const t = useTranslations('payment')
  const tc = useTranslations('common')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleConfirmPayment = async () => {
    if (!stripe || !elements) return

    setSubmitting(true)
    setError('')

    try {
      const { error: stripeError } = await stripe.confirmPayment({
        elements,
        redirect: 'if_required',
      })

      if (stripeError) {
        setError(stripeError.message || 'Payment failed')
        setSubmitting(false)
        return
      }

      // Payment authorized — confirm with backend
      await bookingService.confirmAuthorization(slug, bookingId)

      // Store booking for confirmation page
      sessionStorage.setItem('lastBooking', JSON.stringify({
        id: bookingId,
        bookingReference,
        hotelName: hotel.name,
        roomName: room.name,
        guestFirstName: guestDetails.guestFirstName,
        guestLastName: guestDetails.guestLastName,
        guestEmail: guestDetails.guestEmail,
        checkIn,
        checkOut,
        nights,
        adults,
        children,
        totalAmount: roomTotal,
        currency: room.currency,
        status: 'pending',
        paymentMethod: 'card',
        paymentStatus: 'authorized',
      }))

      router.push(`/booking/${bookingReference}`)
    } catch (err: any) {
      setError(err.message || 'Payment confirmation failed')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="relative h-32 w-full">
        <Image src={hotel.heroImage} alt={hotel.name} fill className="object-cover" priority />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60" />
        <BookingNavigation />
      </div>

      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">{t('confirmPayment') || 'Confirm Payment'}</h2>
          <p className="text-gray-600 mb-6">
            {t('confirmPaymentDesc') || 'Complete your payment to submit the booking request. Your card will be authorized but not charged until the host accepts.'}
          </p>

          <div className="mb-6 p-4 bg-gray-50 rounded-xl">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-gray-500">{room.name}</span>
              <span className="font-semibold text-gray-900">{formatPrice(roomTotal, room.currency)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">{formatDate(checkIn, locale)} — {formatDate(checkOut, locale)}</span>
              <span className="text-gray-500">{tc('nights', { count: nights })}</span>
            </div>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mb-6">
            <PaymentElement />
          </div>

          <button
            onClick={handleConfirmPayment}
            disabled={!stripe || submitting}
            className={`w-full py-3 text-center font-semibold rounded-lg transition-colors text-sm ${
              !stripe || submitting
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                : 'bg-primary-600 text-white hover:bg-primary-700'
            }`}
          >
            {submitting
              ? (t('processing') || 'Processing...')
              : (t('authorizePayment') || `Authorize ${formatPrice(roomTotal, room.currency)}`)
            }
          </button>

          <p className="text-xs text-gray-500 text-center mt-3">
            {t('authorizationNote') || 'Your card will only be charged if the host accepts your booking within 24 hours.'}
          </p>
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
