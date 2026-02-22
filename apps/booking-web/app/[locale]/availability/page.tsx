'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import { useHotel, useRooms, useSlug } from '@/contexts/HotelContext'
import { calculateNights, formatDateShort, formatDate } from '@/lib/utils'
import { useCurrency } from '@/contexts/CurrencyContext'
import { hotelService } from '@/services/api/hotel'
import { RoomType } from '@/lib/types'

export default function AvailabilityPage() {
  const locale = useLocale()
  const t = useTranslations('availability')
  const tc = useTranslations('common')
  const { hotel } = useHotel()
  const { rooms: initialRooms } = useRooms()
  const { formatPrice } = useCurrency()
  const [checkIn, setCheckIn] = useState('2026-02-13')
  const [checkOut, setCheckOut] = useState('2026-02-18')
  const [adults, setAdults] = useState(2)
  const [children, setChildren] = useState(0)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchResults, setSearchResults] = useState<RoomType[]>([])
  const [searching, setSearching] = useState(false)
  const { slug } = useSlug()

  const nights = checkIn && checkOut ? calculateNights(checkIn, checkOut) : 0

  const handleSearch = async () => {
    setSearching(true)
    try {
      const rooms = await hotelService.getRooms(slug, checkIn, checkOut)
      setSearchResults(rooms)
      setHasSearched(true)
    } catch (err) {
      console.error('Failed to search rooms:', err)
      setSearchResults(initialRooms)
      setHasSearched(true)
    } finally {
      setSearching(false)
    }
  }

  const displayRooms = hasSearched ? searchResults : initialRooms

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

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Search Form */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-8">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
            {/* Check-in */}
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                {t('checkIn')}
              </label>
              <input
                type="date"
                value={checkIn}
                onChange={(e) => setCheckIn(e.target.value)}
                className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            {/* Check-out */}
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                {t('checkOut')}
              </label>
              <input
                type="date"
                value={checkOut}
                onChange={(e) => setCheckOut(e.target.value)}
                min={checkIn}
                className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            {/* Adults */}
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                {t('adults')}
              </label>
              <div className="flex items-center border border-gray-300 rounded-lg bg-gray-50">
                <button
                  onClick={() => setAdults(Math.max(1, adults - 1))}
                  className="px-3 py-3 text-gray-500 hover:text-gray-700"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                  </svg>
                </button>
                <span className="flex-1 text-center font-semibold text-gray-900">{adults}</span>
                <button
                  onClick={() => setAdults(Math.min(6, adults + 1))}
                  className="px-3 py-3 text-gray-500 hover:text-gray-700"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Children */}
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                {t('children')}
              </label>
              <div className="flex items-center border border-gray-300 rounded-lg bg-gray-50">
                <button
                  onClick={() => setChildren(Math.max(0, children - 1))}
                  className="px-3 py-3 text-gray-500 hover:text-gray-700"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                  </svg>
                </button>
                <span className="flex-1 text-center font-semibold text-gray-900">{children}</span>
                <button
                  onClick={() => setChildren(Math.min(4, children + 1))}
                  className="px-3 py-3 text-gray-500 hover:text-gray-700"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Search Button */}
            <button
              onClick={handleSearch}
              disabled={searching}
              className="w-full px-6 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {searching ? '...' : tc('search')}
            </button>
          </div>

          {nights > 0 && (
            <p className="text-sm text-gray-500 mt-3">
              {formatDateShort(checkIn, locale)} — {formatDate(checkOut, locale)} &middot; {tc('nights', { count: nights })} &middot; {tc('adults', { count: adults })}
              {children > 0 && `, ${tc('children', { count: children })}`}
            </p>
          )}
        </div>

        {/* Results */}
        {displayRooms.length > 0 && (
          <>
            <h2 className="text-xl font-bold text-gray-900 mb-4">
              {t('roomsAvailable', { count: displayRooms.filter(r => r.remainingRooms > 0).length })}
            </h2>
            <div className="space-y-4">
              {displayRooms.map((room) => {
                const total = room.baseRate * nights
                const soldOut = room.remainingRooms === 0
                return (
                  <div
                    key={room.id}
                    className={`bg-white border border-gray-200 rounded-xl overflow-hidden hover:shadow-md transition-shadow ${soldOut ? 'opacity-60' : ''}`}
                  >
                    <div className="flex flex-col md:flex-row">
                      <div className="relative w-full md:w-64 h-48 md:h-auto flex-shrink-0">
                        <Image
                          src={room.images[0]}
                          alt={room.name}
                          fill
                          className="object-cover"
                        />
                        {soldOut ? (
                          <div className="absolute top-3 left-3 bg-gray-700 text-white text-xs font-bold px-2.5 py-1 rounded-full">
                            Sold Out
                          </div>
                        ) : room.remainingRooms <= 3 ? (
                          <div className="absolute top-3 left-3 bg-red-500 text-white text-xs font-bold px-2.5 py-1 rounded-full">
                            {tc('left', { count: room.remainingRooms })}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex-1 p-5 flex flex-col">
                        <div className="flex-1">
                          <h3 className="text-lg font-bold text-gray-900">{room.name}</h3>
                          <p className="text-sm text-gray-500 mt-0.5 mb-3">
                            {room.size} m&sup2; &middot; {room.bedType} &middot; {t('maxGuests', { count: room.maxOccupancy })}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {room.features.slice(0, 3).map((f) => (
                              <span key={f} className="inline-flex items-center gap-1 text-sm text-gray-600">
                                <svg className="w-3.5 h-3.5 text-success-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                {f}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-end justify-between pt-4 mt-4 border-t border-gray-100">
                          <div>
                            <span className="text-2xl font-bold text-gray-900">
                              {formatPrice(room.baseRate, room.currency)}
                            </span>
                            <span className="text-sm text-gray-500 ml-1">{tc('perNight')}</span>
                            {nights > 0 && (
                              <p className="text-sm text-gray-500">
                                {t('totalLabel', { amount: formatPrice(total, room.currency) })}
                              </p>
                            )}
                          </div>
                          {soldOut ? (
                            <span className="px-6 py-2.5 bg-gray-300 text-gray-500 font-semibold rounded-full text-sm cursor-not-allowed">
                              Sold Out
                            </span>
                          ) : (
                            <Link
                              href={`/book?room=${room.id}&checkIn=${checkIn}&checkOut=${checkOut}&adults=${adults}&children=${children}`}
                              className="px-6 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm"
                            >
                              {tc('bookNow')}
                            </Link>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      <BookingFooter />
    </div>
  )
}
