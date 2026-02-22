'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import { useHotel, useSlug } from '@/contexts/HotelContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { bookingService } from '@/services/api/booking'
import { Booking } from '@/lib/types'

export default function MyBookingPage() {
  const t = useTranslations('myBooking')
  const tc = useTranslations('common')
  const { hotel } = useHotel()
  const { formatPrice } = useCurrency()
  const [reference, setReference] = useState('')
  const [email, setEmail] = useState('')
  const [booking, setBooking] = useState<Booking | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const { slug } = useSlug()

  const handleSearch = async () => {
    if (!reference || !email) return
    setSearching(true)
    setError('')
    setBooking(null)

    try {
      const result = await bookingService.lookup(slug, reference, email)
      setBooking(result)
    } catch (err: any) {
      setError(err.message || t('notFound') || 'Booking not found')
    } finally {
      setSearching(false)
    }
  }

  const statusColor: Record<string, string> = {
    confirmed: 'text-success-600',
    pending: 'text-yellow-600',
    cancelled: 'text-red-600',
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* Mini Hero */}
      <div className="relative h-48 w-full">
        <Image
          src={hotel.heroImage}
          alt={hotel.name}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60" />
        <BookingNavigation />
        <div className="absolute inset-0 flex items-center justify-center">
          <h1 className="text-3xl md:text-4xl font-heading italic text-white">{t('title')}</h1>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Lookup Form */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-2">{t('lookUp')}</h2>
          <p className="text-sm text-gray-600 mb-6">
            {t('lookUpDesc')}
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('reference')} *</label>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value.toUpperCase())}
                placeholder="VAY-XXXXXX"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-gray-50 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400 uppercase tracking-wider"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('emailAddress')} *</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="john@example.com"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-gray-50 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
              />
            </div>
            <button
              onClick={handleSearch}
              disabled={searching || !reference || !email}
              className="w-full py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {searching ? '...' : t('findBooking')}
            </button>
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Result */}
        {booking && (
          <div className="mt-6 bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-success-100 rounded-full flex items-center justify-center">
                <svg className="w-5 h-5 text-success-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="font-bold text-gray-900">{t('bookingFound')}</p>
                <p className={`text-sm font-medium capitalize ${statusColor[booking.status] || ''}`}>
                  {booking.status}
                </p>
              </div>
            </div>

            <div className="space-y-0 divide-y divide-gray-100">
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t('reference')}</span>
                <span className="font-medium text-gray-900 text-sm">{booking.bookingReference}</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t('hotel')}</span>
                <span className="font-medium text-gray-900 text-sm">{booking.hotelName}</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t('room')}</span>
                <span className="font-medium text-gray-900 text-sm">{booking.roomName}</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t('checkIn')}</span>
                <span className="font-medium text-gray-900 text-sm">{booking.checkIn}</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t('checkOut')}</span>
                <span className="font-medium text-gray-900 text-sm">{booking.checkOut}</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t('guests')}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {booking.adults} Adult{booking.adults !== 1 ? 's' : ''}
                  {booking.children > 0 && `, ${booking.children} Child${booking.children !== 1 ? 'ren' : ''}`}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t('total')}</span>
                <span className="font-bold text-gray-900">
                  {formatPrice(booking.totalAmount, booking.currency)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <BookingFooter />
    </div>
  )
}
