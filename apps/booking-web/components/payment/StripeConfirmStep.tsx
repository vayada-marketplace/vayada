'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { useStripe, useElements, PaymentElement } from '@stripe/react-stripe-js'
import BookingFooter from '@/components/layout/BookingFooter'
import HeroSection from '@/components/booking/HeroSection'
import { Hotel, RoomType, Addon, Booking } from '@/lib/types'
import { bookingService } from '@/services/api/booking'
import { saveLastBooking } from '@/lib/storage/bookingDraft'

interface StripeConfirmStepProps {
  hotel: Hotel
  room: RoomType
  checkIn: string
  checkOut: string
  nights: number
  adults: number
  roomTotal: number
  addons: Addon[]
  selectedAddonIds: string[]
  addonQuantities: Record<string, number>
  addonTotal: number
  grandTotal: number
  booking: Booking
  slug: string
  formatPrice: (amount: number, fromCurrency: string) => string
  formatDate: (date: string | Date, locale?: string) => string
  locale: string
  roomsParam: number
  selectedCurrency: string
  convertAndRound: (amount: number, fromCurrency: string) => number
}

export default function StripeConfirmStep({
  hotel,
  room,
  checkIn,
  checkOut,
  nights,
  adults,
  roomTotal,
  addons,
  selectedAddonIds,
  addonQuantities,
  addonTotal,
  grandTotal,
  booking,
  slug,
  formatPrice,
  formatDate,
  locale,
  roomsParam,
  selectedCurrency,
  convertAndRound,
}: StripeConfirmStepProps) {
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

      await bookingService.confirmAuthorization(slug, booking.id)
      saveLastBooking({
        ...booking,
        paymentMethod: 'card',
        paymentStatus: 'authorized',
      })
      router.push(`/booking/${booking.bookingReference}`)
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
            {hotel.instantBook
              ? (t('confirmPaymentDescInstant') || 'Complete your payment to confirm the booking. Your card will be charged now.')
              : (t('confirmPaymentDesc') || 'Complete your payment to submit the booking request. Your card will be authorized but not charged until the host accepts.')}
          </p>

          <div className="mb-6 p-4 bg-accent rounded-xl space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">{roomsParam > 1 ? `${roomsParam}× ` : ''}{room.name}</span>
              <span className="font-semibold text-gray-900">{formatPrice(roomTotal, selectedCurrency)}</span>
            </div>
            {addons.filter((a) => selectedAddonIds.includes(a.id)).map((addon) => {
              const qty = addon.perNight ? (addonQuantities?.[addon.id] ?? nights) : (addonQuantities?.[addon.id] ?? 1)
              const unitPriceDisplay = convertAndRound(addon.price * qty, addon.currency)
              const annotation = addon.perNight
                ? (qty < nights ? ` (${qty}/${nights})` : '')
                : addon.perPerson
                  ? ` (${qty}/${adults})`
                  : qty > 1 ? ` ×${qty}` : ''
              return (
                <div key={addon.id} className="flex justify-between text-sm">
                  <span className="text-gray-500">{addon.name}{annotation}</span>
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
