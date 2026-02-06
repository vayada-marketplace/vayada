'use client'

import { useState } from 'react'
import Image from 'next/image'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import { useHotel } from '@/contexts/HotelContext'

export default function MyBookingPage() {
  const { hotel } = useHotel()
  const [reference, setReference] = useState('')
  const [email, setEmail] = useState('')
  const [showResult, setShowResult] = useState(false)

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
          <h1 className="text-3xl md:text-4xl font-serif italic text-white">My Booking</h1>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Lookup Form */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-2">Look Up Your Booking</h2>
          <p className="text-sm text-gray-600 mb-6">
            Enter your booking reference and email address to view your reservation details.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Booking Reference *</label>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value.toUpperCase())}
                placeholder="VBK-XXXXXX"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-gray-50 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400 uppercase tracking-wider"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Email Address *</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="john@example.com"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-gray-50 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
              />
            </div>
            <button
              onClick={() => setShowResult(true)}
              className="w-full py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors"
            >
              Find My Booking
            </button>
          </div>
        </div>

        {/* Result */}
        {showResult && (
          <div className="mt-6 bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-success-100 rounded-full flex items-center justify-center">
                <svg className="w-5 h-5 text-success-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="font-bold text-gray-900">Booking Found</p>
                <p className="text-sm text-success-600">Confirmed</p>
              </div>
            </div>

            <div className="space-y-0 divide-y divide-gray-100">
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">Reference</span>
                <span className="font-medium text-gray-900 text-sm">{reference || 'VBK-A1B2C3'}</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">Hotel</span>
                <span className="font-medium text-gray-900 text-sm">{hotel.name}</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">Room</span>
                <span className="font-medium text-gray-900 text-sm">Superior Mountain View</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">Check-in</span>
                <span className="font-medium text-gray-900 text-sm">13 Feb 2026</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">Check-out</span>
                <span className="font-medium text-gray-900 text-sm">18 Feb 2026</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">Guests</span>
                <span className="font-medium text-gray-900 text-sm">2 Adults</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">Total</span>
                <span className="font-bold text-gray-900">&euro;900</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <BookingFooter />
    </div>
  )
}
