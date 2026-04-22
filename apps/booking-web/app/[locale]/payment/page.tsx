'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import Image from 'next/image'
import { useStripe, useElements, PaymentElement } from '@stripe/react-stripe-js'
import BookingFooter from '@/components/layout/BookingFooter'
import HeroSection from '@/components/booking/HeroSection'
import StepIndicator from '@/components/booking/StepIndicator'
import StripeProvider from '@/components/StripeProvider'
import { useHotel, useRooms, useAddons, useSlug } from '@/contexts/HotelContext'
import { calculateNights, formatDate } from '@/lib/utils'
import { useCurrency } from '@/contexts/CurrencyContext'
import { bookingService } from '@/services/api/booking'
import { getNonRefundableRate, calculatePromoDiscount, getFreeCancellationDays } from '@/lib/constants/booking'
import { hotelService } from '@/services/api/hotel'

interface GuestDetails {
  roomTypeId: string
  guestFirstName: string
  guestLastName: string
  guestEmail: string
  guestPhone: string
  specialRequests: string
  estimatedArrivalTime?: string
  numberOfGuests?: number
  referralCode?: string
  addonIds?: string[]
  addonQuantities?: Record<string, number>
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
  const { rooms, refetchRooms } = useRooms()
  const { addons } = useAddons()
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency()
  const { slug } = useSlug()
  const searchParams = useSearchParams()

  const roomId = searchParams.get('room') || ''
  const checkIn = searchParams.get('checkIn') || ''
  const checkOut = searchParams.get('checkOut') || ''

  const adultsParam = parseInt(searchParams.get('adults') || '2')

  // Ensure rooms have date-resolved rates
  useEffect(() => {
    if (checkIn && checkOut) refetchRooms(checkIn, checkOut, adultsParam)
  }, [])
  const childrenParam = parseInt(searchParams.get('children') || '0')
  const roomsParam = parseInt(searchParams.get('rooms') || '1')
  const currentStep = 4

  const STEPS = [
    { number: 1, label: ts('rooms') },
    { number: 2, label: ts('addons') },
    { number: 3, label: ts('details') },
    { number: 4, label: ts('payment') },
  ]

  const rateType = searchParams.get('rateType') || 'flexible'
  const isNonRefundable = rateType === 'nonrefundable'

  const room = rooms.find((r) => r.id === roomId) || rooms[0]
  const nights = calculateNights(checkIn, checkOut)
  const nightlyRateBase = isNonRefundable
    ? getNonRefundableRate(room.baseRate, room?.nonRefundableRate)
    : room?.baseRate ?? 0
  const roomCurrency = room?.currency || hotel?.currency || 'EUR'
  // Per-night rate rounded in the displayed currency so nightly × nights equals
  // the shown total (avoids "$25 × 3 = $76" conversion rounding mismatch).
  const nightlyRate = room ? convertAndRound(nightlyRateBase, roomCurrency) : 0
  const roomTotal = nightlyRate * nights * roomsParam

  const [guestDetails, setGuestDetails] = useState<GuestDetails | null>(null)
  const selectedAddonIds = guestDetails?.addonIds || []
  const addonQuantities = guestDetails?.addonQuantities || {}
  const addonTotal = (() => {
    let total = 0
    for (const addon of addons) {
      if (!selectedAddonIds.includes(addon.id)) continue
      const qty = addon.perNight ? (addonQuantities[addon.id] ?? nights) : (addonQuantities[addon.id] ?? 1)
      let price = addon.price
      if (addon.perPerson) price *= adultsParam
      price *= qty
      total += convertAndRound(price, addon.currency)
    }
    return total
  })()
  const promoCodeParam = searchParams.get('promoCode') || ''
  const [promoDiscount, setPromoDiscount] = useState<{ type: string; value: number; amount: number } | null>(null)

  useEffect(() => {
    if (promoCodeParam && slug) {
      hotelService.validatePromoCode(slug, promoCodeParam).then((res) => {
        if (res.valid) {
          const subtotal = roomTotal + addonTotal
          const value = res.discountType === 'fixed'
            ? convertAndRound(res.discountValue!, roomCurrency)
            : res.discountValue!
          const amount = calculatePromoDiscount(subtotal, res.discountType!, value)
          setPromoDiscount({ type: res.discountType!, value: res.discountValue!, amount })
        }
      }).catch(() => {})
    }
  }, [promoCodeParam, slug, roomTotal, addonTotal, roomCurrency, convertAndRound])

  const discountAmount = promoDiscount?.amount ?? 0
  const grandTotal = roomTotal + addonTotal - discountAmount
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'pay_at_property' | 'xendit' | 'bank_transfer'>('pay_at_property')
  const [payAtPropertyEnabled, setPayAtPropertyEnabled] = useState(false)
  const [onlineCardPayment, setOnlineCardPayment] = useState(false)
  const [xenditPaymentsEnabled, setXenditPaymentsEnabled] = useState(false)
  const [bankTransferEnabled, setBankTransferEnabled] = useState(false)
  const [bankDetails, setBankDetails] = useState<{ accountHolder: string; accountType?: 'iban' | 'account_number'; iban: string; accountNumber?: string; bankName: string; swift: string } | null>(null)
  const [payAtHotelMethods, setPayAtHotelMethods] = useState<string[]>(['cash', 'card'])
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

  // Per-rate allow-list from the room. When null, every hotel-enabled method is
  // offered (pre-Bug-2 behavior). When set, only methods in the list for the
  // selected rate are offered — replacing the old hardcoded !isNonRefundable gates.
  const rateAllowList: string[] | null =
    room?.ratePaymentMethods?.[rateType] && Array.isArray(room.ratePaymentMethods[rateType])
      ? room.ratePaymentMethods[rateType]
      : null
  const isMethodAllowedForRate = (method: string) =>
    rateAllowList === null ? true : rateAllowList.includes(method)

  // Check if pay-at-property is enabled
  useEffect(() => {
    if (slug) {
      bookingService.getPaymentSettings(slug).then((settings) => {
        setPayAtPropertyEnabled(settings.payAtPropertyEnabled)
        setOnlineCardPayment(settings.onlineCardPayment || false)
        setXenditPaymentsEnabled(settings.xenditPaymentsEnabled || false)
        setBankTransferEnabled(settings.bankTransfer || false)
        if (settings.bankDetails) setBankDetails(settings.bankDetails)
        if (settings.payAtHotelMethods) setPayAtHotelMethods(settings.payAtHotelMethods)
        // Default to first available payment method, honoring the rate-level
        // allow-list if one is set on this room.
        const preference: ('card' | 'pay_at_property' | 'bank_transfer' | 'xendit')[] = ['card', 'pay_at_property', 'bank_transfer', 'xendit']
        const hotelEnabled: Record<string, boolean> = {
          card: !!settings.onlineCardPayment,
          pay_at_property: !!settings.payAtPropertyEnabled,
          bank_transfer: !!settings.bankTransfer,
          xendit: !!settings.xenditPaymentsEnabled,
        }
        for (const m of preference) {
          if (hotelEnabled[m] && isMethodAllowedForRate(m)) {
            setPaymentMethod(m)
            break
          }
        }
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, rateType, room?.id])

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
        numberOfRooms: roomsParam,
        paymentMethod,
        rateType,
        addonIds: selectedAddonIds,
        addonQuantities,
        promoCode: promoCodeParam || undefined,
      })

      const booking = result.booking
      setBookingId(booking.id)
      setBookingReference(booking.bookingReference)

      if (paymentMethod === 'card' && result.clientSecret) {
        setClientSecret(result.clientSecret)
        // The Stripe form will be rendered, user confirms payment there
      } else if (paymentMethod === 'xendit' && result.xenditInvoiceUrl) {
        // Redirect to Xendit payment page (QRIS, e-wallets, VA)
        sessionStorage.setItem('lastBooking', JSON.stringify(booking))
        window.location.href = result.xenditInvoiceUrl
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
          addons={addons}
          selectedAddonIds={selectedAddonIds}
          addonQuantities={addonQuantities}
          addonTotal={addonTotal}
          grandTotal={grandTotal}
          guestDetails={guestDetails}
          bookingId={bookingId}
          bookingReference={bookingReference!}
          slug={slug}
          formatPrice={formatPrice}
          formatDate={formatDate}
          locale={locale}
          roomsParam={roomsParam}
          selectedCurrency={selectedCurrency}
          convertAndRound={convertAndRound}
        />
      </StripeProvider>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <HeroSection heroImage={hotel.heroImage} hotelName={hotel.name} description={hotel.description} />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-10 gap-4">
          <h2 className="text-3xl font-heading text-gray-900">{t('securePayment')}</h2>
          <StepIndicator steps={STEPS} currentStep={currentStep} />
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
              <div className="space-y-3 mb-6">
                {onlineCardPayment && isMethodAllowedForRate('card') && (
                <button
                  onClick={() => setPaymentMethod('card')}
                  className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                    paymentMethod === 'card'
                      ? 'border-primary-600 bg-primary-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${paymentMethod === 'card' ? 'border-primary-600' : 'border-gray-300'}`}>
                      {paymentMethod === 'card' && <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-0.5">
                        <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                        </svg>
                        <span className="font-semibold text-sm text-gray-900">{t('payWithCard') || 'Credit / Debit Card'}</span>
                      </div>
                      <p className="text-xs text-gray-500 ml-7">{t('cardAuthNote') || 'Secure payment via Stripe. Your card will be authorized when the host confirms.'}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] font-medium text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">Visa</span>
                      <span className="text-[10px] font-medium text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">Mastercard</span>
                    </div>
                  </div>
                </button>
                )}
                {xenditPaymentsEnabled && isMethodAllowedForRate('xendit') && (
                  <button
                    onClick={() => setPaymentMethod('xendit')}
                    className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                      paymentMethod === 'xendit'
                        ? 'border-primary-600 bg-primary-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${paymentMethod === 'xendit' ? 'border-primary-600' : 'border-gray-300'}`}>
                        {paymentMethod === 'xendit' && <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                          </svg>
                          <span className="font-semibold text-sm text-gray-900">QRIS / E-Wallet / Bank Transfer</span>
                        </div>
                        <p className="text-xs text-gray-500 ml-7">OVO, DANA, ShopeePay, GoPay, or Indonesian bank transfer via Xendit</p>
                      </div>
                    </div>
                  </button>
                )}
                {payAtPropertyEnabled && isMethodAllowedForRate('pay_at_property') && (
                  <button
                    onClick={() => setPaymentMethod('pay_at_property')}
                    className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                      paymentMethod === 'pay_at_property'
                        ? 'border-primary-600 bg-primary-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${paymentMethod === 'pay_at_property' ? 'border-primary-600' : 'border-gray-300'}`}>
                        {paymentMethod === 'pay_at_property' && <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                          </svg>
                          <span className="font-semibold text-sm text-gray-900">{t('payAtProperty') || 'Pay at Property'}</span>
                        </div>
                        <p className="text-xs text-gray-500 ml-7">
                          {payAtHotelMethods.length === 1 && payAtHotelMethods[0] === 'cash'
                            ? (t('payAtPropertyCashOnly') || 'Pay with cash at check-in — no online payment needed')
                            : payAtHotelMethods.length === 1 && payAtHotelMethods[0] === 'card'
                              ? (t('payAtPropertyCardOnly') || 'Pay with card at check-in — no online payment needed')
                              : (t('payAtPropertyNote') || 'Pay at check-in — cash & card accepted, no online payment needed')}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
                {bankTransferEnabled && isMethodAllowedForRate('bank_transfer') && (
                  <button
                    onClick={() => setPaymentMethod('bank_transfer')}
                    className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                      paymentMethod === 'bank_transfer'
                        ? 'border-primary-600 bg-primary-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${paymentMethod === 'bank_transfer' ? 'border-primary-600' : 'border-gray-300'}`}>
                        {paymentMethod === 'bank_transfer' && <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l9-4 9 4M3 6v12l9 4 9-4V6M3 6l9 4 9-4M12 10v10" />
                          </svg>
                          <span className="font-semibold text-sm text-gray-900">{t('bankTransfer') || 'Bank Transfer'}</span>
                        </div>
                        <p className="text-xs text-gray-500 ml-7">
                          {t('bankTransferNote') || 'Transfer directly to the hotel\'s bank account'}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
              </div>

              {/* Hint when the rate restricts some hotel-enabled methods */}
              {rateAllowList !== null && (
                (payAtPropertyEnabled && !isMethodAllowedForRate('pay_at_property')) ||
                (bankTransferEnabled && !isMethodAllowedForRate('bank_transfer'))
              ) && (
                <p className="text-xs text-gray-400 mb-4">
                  {t('ratePaymentHint') || 'Some payment methods are not available for this rate.'}
                </p>
              )}

              {/* Payment method info */}
              {paymentMethod === 'card' ? (
                <div className="space-y-3">
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700">
                    {t('cardAuthExplanation') || 'Your card will be authorized but not charged until the host accepts your booking. The hold will be released if the booking is declined or expires.'}
                  </div>
                  <div className="flex items-center gap-2 p-3 bg-accent rounded-xl text-sm text-gray-600">
                    <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                    {t('cardNextStep') || 'You will enter your card details in the next step.'}
                  </div>
                </div>
              ) : paymentMethod === 'xendit' ? (
                <div className="space-y-3">
                  <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700">
                    You will be redirected to a secure payment page where you can pay with QRIS, OVO, DANA, ShopeePay, GoPay, or bank transfer. The host will review your booking after payment is confirmed.
                  </div>
                </div>
              ) : paymentMethod === 'bank_transfer' ? (
                <div className="space-y-3">
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700">
                    {t('bankTransferExplanation') || 'Please transfer the total amount to the bank account below. Your booking will be confirmed once the hotel verifies the payment.'}
                  </div>
                  {bankDetails && (bankDetails.iban || bankDetails.accountNumber || bankDetails.accountHolder) && (
                    <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl space-y-2">
                      {bankDetails.bankName && (
                        <p className="text-sm text-gray-700"><strong>{t('bankName') || 'Bank'}:</strong> {bankDetails.bankName}</p>
                      )}
                      {bankDetails.accountHolder && (
                        <p className="text-sm text-gray-700"><strong>{t('accountHolder') || 'Account Holder'}:</strong> {bankDetails.accountHolder}</p>
                      )}
                      {bankDetails.accountType === 'account_number' && bankDetails.accountNumber ? (
                        <p className="text-sm text-gray-700"><strong>{t('accountNumber') || 'Account Number'}:</strong> {bankDetails.accountNumber}</p>
                      ) : bankDetails.iban ? (
                        <p className="text-sm text-gray-700"><strong>IBAN:</strong> {bankDetails.iban}</p>
                      ) : null}
                      {bankDetails.swift && (
                        <p className="text-sm text-gray-700"><strong>BIC/SWIFT:</strong> {bankDetails.swift}</p>
                      )}
                    </div>
                  )}
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
                  {paymentMethod === 'card' ? t.rich('agreeTerms', {
                    terms: (chunks) => <a href="#" className="text-primary-600 underline font-medium">{chunks}</a>,
                    cancellation: (chunks) => <a href="#" className="text-primary-600 underline font-medium">{chunks}</a>,
                    amount: formatPrice(grandTotal, selectedCurrency),
                  }) : t.rich('agreeTermsProperty', {
                    terms: (chunks) => <a href="#" className="text-primary-600 underline font-medium">{chunks}</a>,
                    cancellation: (chunks) => <a href="#" className="text-primary-600 underline font-medium">{chunks}</a>,
                  })}
                </span>
              </label>
            </div>

            {/* Cancellation Policy */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h3 className="text-base font-bold text-gray-900 mb-2">{t('cancellationPolicyTitle')}</h3>
              <p className="text-sm text-gray-600">
                {t('cancellationPolicyDesc', {
                  date: formatDate(
                    new Date(new Date(checkIn).getTime() - getFreeCancellationDays(room?.cancellationPolicy) * 86400000).toISOString().slice(0, 10),
                    locale,
                  ),
                })}
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => {
                  const params = new URLSearchParams({
                    room: roomId,
                    checkIn,
                    checkOut,
                    adults: String(adultsParam),
                    children: String(childrenParam),
                    rooms: String(roomsParam),
                    rateType,
                  })
                  if (promoCodeParam) params.set('promoCode', promoCodeParam)
                  router.push(`/book?${params.toString()}`)
                }}
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
                  <p className="text-sm font-bold text-gray-900">{roomsParam > 1 ? `${roomsParam}× ` : ''}{room.name}</p>
                  <p className="text-xs text-gray-500">{isNonRefundable ? tb('nonRefundableRate') : tb('flexibleRate')}</p>
                </div>
              </div>

              {/* Stay details */}
              <div className="space-y-3 py-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{tb('checkIn')}</span>
                  <span className="font-semibold text-gray-900 text-right">
                    {formatDate(checkIn, locale)}
                    {hotel.checkInTime && <span className="block text-xs font-normal text-gray-500">{tc('checkInFrom', { time: hotel.checkInTime })}</span>}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{tb('checkOut')}</span>
                  <span className="font-semibold text-gray-900 text-right">
                    {formatDate(checkOut, locale)}
                    {hotel.checkOutTime && <span className="block text-xs font-normal text-gray-500">{tc('checkOutBy', { time: hotel.checkOutTime })}</span>}
                  </span>
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
                  <span className="font-semibold text-gray-900">{formatPrice(roomTotal, selectedCurrency)}</span>
                </div>
                {addons.filter((a) => selectedAddonIds.includes(a.id)).map((addon) => {
                  const qty = addon.perNight ? (addonQuantities[addon.id] ?? nights) : (addonQuantities[addon.id] ?? 1)
                  let unitPrice = addon.price
                  if (addon.perPerson) unitPrice *= adultsParam
                  unitPrice *= qty
                  const unitPriceDisplay = convertAndRound(unitPrice, addon.currency)
                  return (
                    <div key={addon.id} className="flex justify-between text-sm">
                      <span className="text-gray-500">{addon.name}{addon.perNight && qty < nights ? ` (${qty}/${nights})` : qty > 1 && !addon.perNight ? ` ×${qty}` : ''}</span>
                      <span className="font-semibold text-gray-900">{formatPrice(unitPriceDisplay, selectedCurrency)}</span>
                    </div>
                  )
                })}
              </div>

              {/* Promo Discount */}
              {promoDiscount && (
                <div className="flex justify-between text-sm pt-2">
                  <span className="text-primary-600 font-medium">
                    Promo {promoCodeParam}{promoDiscount.type === 'percentage' ? ` (-${promoDiscount.value}%)` : ''}
                  </span>
                  <span className="font-semibold text-primary-600">-{formatPrice(discountAmount, selectedCurrency)}</span>
                </div>
              )}

              {/* Total */}
              <div className="pt-5">
                <div className="flex justify-between items-start">
                  <span className="text-base font-bold text-gray-900">{tc('total')}</span>
                  <div className="text-right">
                    <p className="text-xl font-bold text-gray-900">{formatPrice(grandTotal, selectedCurrency)}</p>
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
  addons,
  selectedAddonIds,
  addonQuantities,
  addonTotal,
  grandTotal,
  guestDetails,
  bookingId,
  bookingReference,
  slug,
  formatPrice,
  formatDate,
  locale,
  roomsParam,
  selectedCurrency,
  convertAndRound,
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
        totalAmount: grandTotal,
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
      <HeroSection heroImage={hotel.heroImage} hotelName={hotel.name} compact />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">{t('confirmPayment') || 'Confirm Payment'}</h2>
          <p className="text-gray-600 mb-6">
            {t('confirmPaymentDesc') || 'Complete your payment to submit the booking request. Your card will be authorized but not charged until the host accepts.'}
          </p>

          <div className="mb-6 p-4 bg-accent rounded-xl space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">{roomsParam > 1 ? `${roomsParam}× ` : ''}{room.name}</span>
              <span className="font-semibold text-gray-900">{formatPrice(roomTotal, selectedCurrency)}</span>
            </div>
            {addons.filter((a: any) => selectedAddonIds.includes(a.id)).map((addon: any) => {
              const qty = addon.perNight ? (addonQuantities?.[addon.id] ?? nights) : (addonQuantities?.[addon.id] ?? 1)
              let unitPrice = addon.price
              if (addon.perPerson) unitPrice *= adults
              unitPrice *= qty
              const unitPriceDisplay = convertAndRound(unitPrice, addon.currency)
              return (
                <div key={addon.id} className="flex justify-between text-sm">
                  <span className="text-gray-500">{addon.name}{addon.perNight && qty < nights ? ` (${qty}/${nights})` : qty > 1 && !addon.perNight ? ` ×${qty}` : ''}</span>
                  <span className="font-semibold text-gray-900">{formatPrice(unitPriceDisplay, selectedCurrency)}</span>
                </div>
              )
            })}
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">{formatDate(checkIn, locale)} — {formatDate(checkOut, locale)}</span>
              <span className="text-gray-500">{tc('nights', { count: nights })}</span>
            </div>
            <div className="flex justify-between text-sm pt-2 border-t border-gray-200">
              <span className="font-semibold text-gray-900">Total</span>
              <span className="font-bold text-gray-900">{formatPrice(grandTotal, selectedCurrency)}</span>
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
              : (t('authorizePayment') || `Authorize ${formatPrice(grandTotal, selectedCurrency)}`)
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
