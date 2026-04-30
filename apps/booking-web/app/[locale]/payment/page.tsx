'use client'

import { useState, useEffect, Suspense, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import Image from 'next/image'
import { Booking } from '@/lib/types'
import BookingFooter from '@/components/layout/BookingFooter'
import HeroSection from '@/components/booking/HeroSection'
import StepIndicator from '@/components/booking/StepIndicator'
import StripeProvider from '@/components/StripeProvider'
import StripeConfirmStep from '@/components/payment/StripeConfirmStep'
import PolicyModal from '@/components/payment/PolicyModal'
import { useHotel, useRooms, useAddons, useSlug } from '@/contexts/HotelContext'
import { formatDate } from '@/lib/utils'
import { useCurrency } from '@/contexts/CurrencyContext'
import { bookingService } from '@/services/api/booking'
import { getFreeCancellationDays } from '@/lib/constants/booking'
import { usePricing } from '@/lib/hooks/usePricing'
import { useBookingSteps } from '@/lib/hooks/useBookingSteps'
import { GuestDetailsDraft, readGuestDetails, saveLastBooking } from '@/lib/storage/bookingDraft'

function PaymentPageContent() {
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations('payment')
  const tc = useTranslations('common')
  const ts = useTranslations('steps')
  const tb = useTranslations('book')
  const { hotel } = useHotel()
  const { refetchRooms } = useRooms()
  const { addons } = useAddons()
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency()
  const { slug } = useSlug()
  const searchParams = useSearchParams()

  const roomId = searchParams.get('room') || ''
  const checkIn = searchParams.get('checkIn') || ''
  const checkOut = searchParams.get('checkOut') || ''

  const adultsParam = parseInt(searchParams.get('adults') || '2')

  // Ensure rooms have date-resolved rates on mount. URL search params stay
  // stable for the lifetime of this page (a checkIn/checkOut change comes
  // from a navigation, which remounts), so reading them from a closure is
  // safe. refetchRooms is intentionally omitted because it isn't memoized
  // by HotelContext and would re-fire on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (checkIn && checkOut) refetchRooms(checkIn, checkOut, adultsParam)
  }, [])
  const childrenParam = parseInt(searchParams.get('children') || '0')
  const roomsParam = parseInt(searchParams.get('rooms') || '1')
  const { steps: STEPS, currentStep } = useBookingSteps('payment')

  const rateType = searchParams.get('rateType') || 'flexible'
  const isNonRefundable = rateType === 'nonrefundable'

  const [guestDetails, setGuestDetails] = useState<GuestDetailsDraft | null>(null)
  const selectedAddonIds = guestDetails?.addonIds || []
  const addonQuantities = guestDetails?.addonQuantities || {}
  const promoCodeParam = searchParams.get('promoCode') || ''

  const {
    room,
    nights,
    roomTotal,
    addonTotal,
    promoDiscount,
    discountAmount,
    grandTotal,
  } = usePricing({
    roomId,
    checkIn,
    checkOut,
    rateType,
    roomsParam,
    selectedAddonIds,
    addonQuantities,
    promoCode: promoCodeParam,
  })
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'pay_at_property' | 'xendit' | 'bank_transfer'>('pay_at_property')
  const [payAtPropertyEnabled, setPayAtPropertyEnabled] = useState(false)
  const [onlineCardPayment, setOnlineCardPayment] = useState(false)
  const [xenditPaymentsEnabled, setXenditPaymentsEnabled] = useState(false)
  const [bankTransferEnabled, setBankTransferEnabled] = useState(false)
  const [bankDetails, setBankDetails] = useState<{ accountHolder: string; accountType?: 'iban' | 'account_number'; iban: string; accountNumber?: string; bankName: string; swift: string } | null>(null)
  const [payAtHotelMethods, setPayAtHotelMethods] = useState<string[]>(['cash', 'card'])
  const [termsText, setTermsText] = useState('')
  const [cancellationPolicyText, setCancellationPolicyText] = useState('')
  const [policyModal, setPolicyModal] = useState<null | 'terms' | 'cancellation'>(null)
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [pendingBooking, setPendingBooking] = useState<Booking | null>(null)

  // Load guest details from the booking draft (set by /book on submit)
  useEffect(() => {
    const draft = readGuestDetails()
    if (draft) setGuestDetails(draft)
    else router.push('/book')
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
        setTermsText(settings.termsText || '')
        setCancellationPolicyText(settings.cancellationPolicyText || '')
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

      if (paymentMethod === 'card' && result.clientSecret) {
        setPendingBooking(booking)
        setClientSecret(result.clientSecret)
        // The Stripe form will be rendered, user confirms payment there
      } else if (paymentMethod === 'xendit' && result.xenditInvoiceUrl) {
        // Redirect to Xendit payment page (QRIS, e-wallets, VA)
        saveLastBooking(booking)
        window.location.href = result.xenditInvoiceUrl
      } else {
        // Pay at property — redirect to confirmation
        saveLastBooking(booking)
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
  if (clientSecret && pendingBooking) {
    return (
      <StripeProvider clientSecret={clientSecret}>
        <StripeConfirmStep
          hotel={hotel}
          room={room}
          checkIn={checkIn}
          checkOut={checkOut}
          nights={nights}
          adults={adultsParam}
          roomTotal={roomTotal}
          addons={addons}
          selectedAddonIds={selectedAddonIds}
          addonQuantities={addonQuantities}
          addonTotal={addonTotal}
          grandTotal={grandTotal}
          booking={pendingBooking}
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
                          <span className="font-semibold text-sm text-gray-900">{t('xenditTitle')}</span>
                        </div>
                        <p className="text-xs text-gray-500 ml-7">{t('xenditNote')}</p>
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
                    {t('xenditExplanation')}
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
                  {hotel.instantBook
                    ? (t('payAtPropertyExplanationInstant') || 'No payment is required now. You will pay directly at the property upon check-in. Your booking will be confirmed instantly.')
                    : (t('payAtPropertyExplanation') || 'No payment is required now. You will pay directly at the property upon check-in. The host will review your booking request.')}
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
                  {(() => {
                    const renderTermsLink = (chunks: ReactNode) => (
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); setPolicyModal('terms') }}
                        className="text-primary-600 underline font-medium hover:text-primary-700"
                      >
                        {chunks}
                      </button>
                    )
                    const renderCancellationLink = (chunks: ReactNode) => (
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); setPolicyModal('cancellation') }}
                        className="text-primary-600 underline font-medium hover:text-primary-700"
                      >
                        {chunks}
                      </button>
                    )
                    return paymentMethod === 'card' ? t.rich('agreeTerms', {
                      terms: renderTermsLink,
                      cancellation: renderCancellationLink,
                      amount: formatPrice(grandTotal, selectedCurrency),
                    }) : t.rich('agreeTermsProperty', {
                      terms: renderTermsLink,
                      cancellation: renderCancellationLink,
                    })
                  })()}
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
                ) : hotel.instantBook ? (
                  t('confirmBooking') || 'Confirm Booking'
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
                  const unitPriceDisplay = convertAndRound(addon.price * qty, addon.currency)
                  const annotation = addon.perNight
                    ? (qty < nights ? ` (${qty}/${nights})` : '')
                    : addon.perPerson
                      ? ` (${qty}/${adultsParam})`
                      : qty > 1 ? ` ×${qty}` : ''
                  return (
                    <div key={addon.id} className="flex justify-between text-sm">
                      <span className="text-gray-500">{addon.name}{annotation}</span>
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

      <PolicyModal
        kind={policyModal}
        onClose={() => setPolicyModal(null)}
        termsText={termsText}
        cancellationPolicyText={cancellationPolicyText}
        cancellationFallback={t('cancellationPolicyDesc', {
          date: formatDate(
            new Date(new Date(checkIn).getTime() - getFreeCancellationDays(room?.cancellationPolicy) * 86400000).toISOString().slice(0, 10),
            locale,
          ),
        })}
      />
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
