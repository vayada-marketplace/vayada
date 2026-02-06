'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import Image from 'next/image'
import { useHotel } from '@/contexts/HotelContext'

export default function BookingConfirmationPage({
  params,
}: {
  params: { reference: string }
}) {
  const t = useTranslations('confirmation')
  const { hotel } = useHotel()

  return (
    <div className="min-h-screen bg-surface">
      {/* Mini Hero */}
      <div className="relative h-32 w-full">
        <Image
          src={hotel.heroImage}
          alt={hotel.name}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60" />
        <BookingNavigation />
      </div>

      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          {/* Success Icon */}
          <div className="w-16 h-16 bg-success-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-success-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <h1 className="text-2xl font-bold text-gray-900 mb-2">{t('title')}</h1>
          <p className="text-gray-600 mb-6">{t('subtitle')}</p>

          {/* Booking Reference */}
          <div className="bg-gray-50 rounded-xl p-4 mb-8 inline-block">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{t('bookingReference')}</p>
            <p className="text-2xl font-bold text-primary-600 tracking-wider">{params.reference}</p>
          </div>

          {/* Booking Details */}
          <div className="text-left space-y-0 divide-y divide-gray-100">
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('hotel')}</span>
              <span className="font-medium text-gray-900">{hotel.name}</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('room')}</span>
              <span className="font-medium text-gray-900">Superior Mountain View</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('checkIn')}</span>
              <span className="font-medium text-gray-900">13 Feb 2026</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('checkOut')}</span>
              <span className="font-medium text-gray-900">18 Feb 2026</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('duration')}</span>
              <span className="font-medium text-gray-900">5 nights</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('guests')}</span>
              <span className="font-medium text-gray-900">2 Adults</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('totalPaid')}</span>
              <span className="font-bold text-gray-900 text-lg">&euro;900</span>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/"
              className="px-6 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors"
            >
              {t('backToHotel')}
            </Link>
            <Link
              href="/my-booking"
              className="px-6 py-3 border border-gray-300 text-gray-700 font-semibold rounded-full hover:bg-gray-50 transition-colors"
            >
              {t('manageBooking')}
            </Link>
          </div>
        </div>

        {/* Email notice */}
        <p className="text-center text-sm text-gray-500 mt-6">
          {t('emailNotice')}
        </p>
      </div>

      <BookingFooter />
    </div>
  )
}
