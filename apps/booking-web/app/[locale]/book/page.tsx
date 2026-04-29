'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import Image from 'next/image'
import BookingFooter from '@/components/layout/BookingFooter'
import HeroSection from '@/components/booking/HeroSection'
import StepIndicator from '@/components/booking/StepIndicator'
import { useHotel, useRooms, useAddons, useSlug } from '@/contexts/HotelContext'
import { bookingService } from '@/services/api/booking'
import { calculateNights, formatDate } from '@/lib/utils'
import { useCurrency } from '@/contexts/CurrencyContext'
import { getNonRefundableRate, calculatePromoDiscount } from '@/lib/constants/booking'
import { COUNTRIES } from '@/lib/constants/countries'
import { hotelService } from '@/services/api/hotel'
import { trackEvent } from '@/services/api/tracking'

const ARRIVAL_TIMES = Array.from({ length: 24 }, (_, i) => {
  const h = i.toString().padStart(2, '0')
  return `${h}:00`
})

function BookPageContent() {
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations('book')
  const tc = useTranslations('common')
  const ts = useTranslations('steps')
  const { hotel } = useHotel()
  const { rooms, refetchRooms } = useRooms()
  const { addons } = useAddons()
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency()
  const { slug } = useSlug()
  const searchParams = useSearchParams()
  const roomId = searchParams.get('room') || ''

  useEffect(() => { trackEvent(slug, 'started_booking') }, [slug])

  // Ensure rooms have date-resolved rates (in case of direct navigation)
  useEffect(() => {
    const ci = searchParams.get('checkIn')
    const co = searchParams.get('checkOut')
    const a = parseInt(searchParams.get('adults') || '2')
    if (ci && co) refetchRooms(ci, co, a)
  }, [])
  const checkIn = searchParams.get('checkIn') || '2026-02-13'
  const checkOut = searchParams.get('checkOut') || '2026-02-18'
  const adultsParam = parseInt(searchParams.get('adults') || '2')
  const childrenParam = parseInt(searchParams.get('children') || '0')
  const roomsParam = parseInt(searchParams.get('rooms') || '1')
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
  const nightlyRateBase = rateType === 'nonrefundable'
    ? getNonRefundableRate(room?.baseRate ?? 0, room?.nonRefundableRate)
    : room?.baseRate ?? 0
  const roomCurrency = room?.currency || hotel?.currency || 'EUR'
  // Per-night rate rounded in the displayed currency so that nightly × nights
  // matches the shown total (avoids "$25 × 3 = $76" conversion rounding mismatch).
  const nightlyRate = room ? convertAndRound(nightlyRateBase, roomCurrency) : 0
  const roomTotal = nightlyRate * nights * roomsParam

  const addonEntries = (searchParams.get('addons') || '').split(',').filter(Boolean)
  const selectedAddonIds: string[] = []
  const addonQuantities: Record<string, number> = {}
  for (const entry of addonEntries) {
    const [id, qtyStr] = entry.split(':')
    selectedAddonIds.push(id)
    if (qtyStr) addonQuantities[id] = parseInt(qtyStr)
  }
  // Sum addon line totals in the displayed currency. Each line is rounded in
  // the displayed currency first so its shown price matches the contribution.
  const addonTotal = (() => {
    let total = 0
    for (const addon of addons) {
      if (!selectedAddonIds.includes(addon.id)) continue
      // perPerson addons: qty already counts the people opting in (the on-card "/person" stepper); don't multiply by room occupancy.
      const qty = addon.perNight ? (addonQuantities[addon.id] ?? nights) : (addonQuantities[addon.id] ?? 1)
      total += convertAndRound(addon.price * qty, addon.currency)
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
          // Fixed-amount promos are stored in the hotel's base currency; convert to
          // the displayed currency so the discount matches the shown subtotal.
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

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [country, setCountry] = useState('')
  const [specialRequests, setSpecialRequests] = useState('')
  const [estimatedArrivalTime, setEstimatedArrivalTime] = useState('')
  const [numberOfGuests, setNumberOfGuests] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [guestFormSettings, setGuestFormSettings] = useState<{
    specialRequestsEnabled: boolean
    arrivalTimeEnabled: boolean
    guestCountEnabled: boolean
  }>({ specialRequestsEnabled: true, arrivalTimeEnabled: false, guestCountEnabled: false })

  useEffect(() => {
    if (slug) {
      // Fetch guest form settings from booking engine backend (source of truth for admin config)
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || ''
      fetch(`${apiUrl}/api/hotels/${slug}/payment-settings`)
        .then((res) => res.ok ? res.json() : null)
        .then((data) => {
          if (data) {
            setGuestFormSettings({
              specialRequestsEnabled: data.specialRequestsEnabled ?? true,
              arrivalTimeEnabled: data.arrivalTimeEnabled ?? false,
              guestCountEnabled: data.guestCountEnabled ?? false,
            })
          }
        })
        .catch(() => {
          // Fallback: try PMS endpoint
          bookingService.getPaymentSettings(slug).then((settings) => {
            setGuestFormSettings({
              specialRequestsEnabled: settings.specialRequestsEnabled ?? true,
              arrivalTimeEnabled: settings.arrivalTimeEnabled ?? false,
              guestCountEnabled: settings.guestCountEnabled ?? false,
            })
          })
        })
    }
  }, [slug])

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
        guestCountry: country,
        specialRequests: guestFormSettings.specialRequestsEnabled ? specialRequests : undefined,
        estimatedArrivalTime: guestFormSettings.arrivalTimeEnabled && estimatedArrivalTime ? estimatedArrivalTime : undefined,
        numberOfGuests: guestFormSettings.guestCountEnabled && numberOfGuests ? parseInt(numberOfGuests) : undefined,
        referralCode,
        addonIds: selectedAddonIds,
        addonQuantities,
      }))

      // Redirect to payment page with booking params
      const params = new URLSearchParams({
        room: room.id,
        checkIn,
        checkOut,
        adults: String(adultsParam),
        children: String(childrenParam),
        rooms: String(roomsParam),
        rateType,
      })
      if (promoCodeParam) params.set('promoCode', promoCodeParam)
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
      <HeroSection heroImage={hotel.heroImage} hotelName={hotel.name} description={hotel.description} />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-10 gap-4">
          <h2 className="text-3xl font-heading text-gray-900">{t('guestInformation')}</h2>

          <StepIndicator steps={STEPS} currentStep={currentStep} />
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
                  <p className="text-sm font-bold text-gray-900">{roomsParam > 1 ? `${roomsParam}× ` : ''}{room.name}</p>
                  <p className="text-sm text-gray-500">
                    {formatDate(checkIn, locale)} - {formatDate(checkOut, locale)} &middot; {tc('nights', { count: nights })}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-gray-900">{formatPrice(roomTotal, selectedCurrency)}</p>
                  <p className="text-xs text-gray-500">{formatPrice(nightlyRate, selectedCurrency)} &times; {nights}</p>
                </div>
              </div>

              {/* Selected Addons */}
              {selectedAddonIds.length > 0 && (
                <div className="pb-5 border-b border-gray-100">
                  {addons.filter((a) => selectedAddonIds.includes(a.id)).map((addon) => {
                    const qty = addon.perNight ? (addonQuantities[addon.id] ?? nights) : (addonQuantities[addon.id] ?? 1)
                    const unitPriceDisplay = convertAndRound(addon.price * qty, addon.currency)
                    const annotation = addon.perNight
                      ? (qty < nights ? ` (${qty}/${nights} ${tc('nights', { count: nights })})` : '')
                      : addon.perPerson
                        ? ` (${qty}/${adultsParam} ${tc('guests').toLowerCase()})`
                        : qty > 1 ? ` ×${qty}` : ''
                    return (
                      <div key={addon.id} className="flex items-center justify-between pt-3">
                        <p className="text-sm text-gray-700">{addon.name}{annotation}</p>
                        <p className="text-sm font-semibold text-gray-900">{formatPrice(unitPriceDisplay, selectedCurrency)}</p>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Promo Discount */}
              {promoDiscount && (
                <div className="flex items-center justify-between pt-3 pb-3 border-b border-gray-100">
                  <p className="text-sm text-primary-600 font-medium">
                    Promo {promoCodeParam}
                    {promoDiscount.type === 'percentage' ? ` (-${promoDiscount.value}%)` : ''}
                  </p>
                  <p className="text-sm font-semibold text-primary-600">-{formatPrice(discountAmount, selectedCurrency)}</p>
                </div>
              )}

              {/* Total */}
              <div className="flex items-center justify-between pt-4">
                <p className="text-base font-bold text-gray-900">{tc('total')}</p>
                <div className="text-right">
                  <p className="text-xl font-bold text-gray-900">{formatPrice(grandTotal, selectedCurrency)}</p>
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
                    <select
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:1.25rem] bg-[right_0.75rem_center] bg-no-repeat"
                    >
                      <option value="">{t('selectCountry')}</option>
                      {COUNTRIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Estimated Arrival Time */}
                {guestFormSettings.arrivalTimeEnabled && (
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      {t('estimatedArrival')}
                    </label>
                    <select
                      value={estimatedArrivalTime}
                      onChange={(e) => setEstimatedArrivalTime(e.target.value)}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:1.25rem] bg-[right_0.75rem_center] bg-no-repeat"
                    >
                      <option value="">{t('selectArrival')}</option>
                      {ARRIVAL_TIMES.map((time) => (
                        <option key={time} value={time}>{time}</option>
                      ))}
                      <option value="unknown">{t('iDontKnow')}</option>
                    </select>
                  </div>
                )}

                {/* Number of Guests */}
                {guestFormSettings.guestCountEnabled && (
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      {t('numberOfGuests')}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={numberOfGuests}
                      onChange={(e) => setNumberOfGuests(e.target.value)}
                      placeholder="2"
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                )}

                {/* Special Requests */}
                {guestFormSettings.specialRequestsEnabled && (
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
                )}
              </div>
            </div>

            {/* Bottom Action Bar */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => {
                  const params = new URLSearchParams()
                  if (checkIn) params.set('checkIn', checkIn)
                  if (checkOut) params.set('checkOut', checkOut)
                  params.set('adults', String(adultsParam))
                  if (childrenParam > 0) params.set('children', String(childrenParam))
                  const qs = params.toString()
                  router.push(qs ? `/?${qs}` : '/')
                }}
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
                  <span className="font-semibold text-gray-900 text-right">
                    {formatDate(checkIn, locale)}
                    {hotel.checkInTime && <span className="block text-xs font-normal text-gray-500">{tc('checkInFrom', { time: hotel.checkInTime })}</span>}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('checkOut')}</span>
                  <span className="font-semibold text-gray-900 text-right">
                    {formatDate(checkOut, locale)}
                    {hotel.checkOutTime && <span className="block text-xs font-normal text-gray-500">{tc('checkOutBy', { time: hotel.checkOutTime })}</span>}
                  </span>
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
