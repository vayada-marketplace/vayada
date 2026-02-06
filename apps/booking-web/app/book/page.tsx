'use client'

import { useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Image from 'next/image'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import { useHotel, useRooms } from '@/contexts/HotelContext'
import { formatCurrency, calculateNights, formatDate } from '@/lib/utils'

const STEPS = [
  { number: 1, label: 'Rooms' },
  { number: 2, label: 'Add-ons' },
  { number: 3, label: 'Details' },
  { number: 4, label: 'Payment' },
]

const COUNTRIES = [
  'Austria', 'Germany', 'Switzerland', 'United States', 'United Kingdom',
  'France', 'Italy', 'Netherlands', 'Spain', 'Australia', 'Canada', 'Japan',
]

const ARRIVAL_TIMES = [
  'I don\'t know yet',
  '12:00 - 13:00',
  '13:00 - 14:00',
  '14:00 - 15:00',
  '15:00 - 16:00',
  '16:00 - 17:00',
  '17:00 - 18:00',
  '18:00 - 19:00',
  '19:00 - 20:00',
  '20:00 - 21:00',
  'After 21:00',
]

function BookPageContent() {
  const router = useRouter()
  const { hotel } = useHotel()
  const { rooms } = useRooms()
  const searchParams = useSearchParams()
  const roomId = searchParams.get('room') || 'room-2'
  const checkIn = searchParams.get('checkIn') || '2026-02-13'
  const checkOut = searchParams.get('checkOut') || '2026-02-18'
  const currentStep = 3

  const room = rooms.find((r) => r.id === roomId) || rooms[1]
  const nights = calculateNights(checkIn, checkOut)
  const roomTotal = room.baseRate * nights
  const addonsTotal = 80 // mock: Airport Transfer
  const total = roomTotal + addonsTotal

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
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-serif italic text-white mb-4">
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
          <h2 className="text-3xl font-serif text-gray-900">Guest Information</h2>

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

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Booking Summary Card */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h3 className="text-lg font-bold text-gray-900 mb-5">Booking Summary</h3>

              {/* Room row */}
              <div className="flex items-start gap-4 pb-5 border-b border-gray-100">
                <div className="relative w-16 h-16 rounded-xl overflow-hidden flex-shrink-0">
                  <Image src={room.images[0]} alt={room.name} fill className="object-cover" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-gray-900">{room.name}</p>
                  <p className="text-sm text-gray-500">
                    {formatDate(checkIn)} - {formatDate(checkOut)} &middot; {nights} nights
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-gray-900">{formatCurrency(roomTotal, room.currency)}</p>
                  <p className="text-xs text-gray-500">{formatCurrency(room.baseRate, room.currency)} &times; {nights}</p>
                </div>
              </div>

              {/* Add-ons row */}
              <div className="py-4 border-b border-gray-100">
                <p className="text-xs font-medium text-gray-500 mb-2">Add-ons:</p>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-700">Airport Transfer</p>
                  <p className="text-sm font-medium text-gray-900">{formatCurrency(addonsTotal, room.currency)}</p>
                </div>
              </div>

              {/* Total */}
              <div className="flex items-center justify-between pt-4">
                <p className="text-base font-bold text-gray-900">Total</p>
                <div className="text-right">
                  <p className="text-xl font-bold text-gray-900">{formatCurrency(total, room.currency)}</p>
                  <p className="text-xs text-gray-500">Includes taxes &amp; fees</p>
                </div>
              </div>
            </div>

            {/* Guest Form Card */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <p className="text-gray-600 mb-6">Please provide your details to complete your reservation.</p>

              <div className="space-y-5">
                {/* First + Last Name */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      First Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="John"
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      Last Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="Doe"
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                </div>

                {/* Email */}
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                    Email Address <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    placeholder="john.doe@example.com"
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                  />
                </div>

                {/* Phone + Country */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      Phone Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="tel"
                      placeholder="+1 234 567 8900"
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      Country <span className="text-red-500">*</span>
                    </label>
                    <select className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:1.25rem] bg-[right_0.75rem_center] bg-no-repeat">
                      <option value="">Select a country</option>
                      {COUNTRIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Estimated Arrival Time */}
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                    Estimated Arrival Time
                  </label>
                  <select className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:1.25rem] bg-[right_0.75rem_center] bg-no-repeat">
                    <option value="">Select an arrival time</option>
                    {ARRIVAL_TIMES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                {/* Special Requests */}
                <div>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                    Special Requests
                  </label>
                  <textarea
                    rows={4}
                    placeholder="Any special requests or preferences for your stay..."
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400 resize-y"
                  />
                </div>
              </div>
            </div>

            {/* Bottom Action Bar */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => router.push('/addons')}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to Add-ons
              </button>
              <a
                href="/payment"
                className="px-8 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm"
              >
                Proceed to Payment
              </a>
            </div>
          </div>

          {/* Right Sidebar — Your Stay */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl border border-gray-200 p-6 sticky top-8">
              <h3 className="text-lg font-bold text-gray-900 mb-5">Your Stay</h3>

              {/* Stay details */}
              <div className="space-y-3 pb-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Room</span>
                  <span className="font-semibold text-gray-900 text-right">{room.name}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Rate</span>
                  <span className="font-semibold text-gray-900">Flexible Rate</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Check-in</span>
                  <span className="font-semibold text-gray-900">{formatDate(checkIn)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Check-out</span>
                  <span className="font-semibold text-gray-900">{formatDate(checkOut)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Duration</span>
                  <span className="font-semibold text-gray-900">{nights} nights</span>
                </div>
              </div>

              {/* Price breakdown */}
              <div className="space-y-3 py-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Room ({nights} nights)</span>
                  <span className="font-semibold text-gray-900">{formatCurrency(roomTotal, room.currency)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Add-ons</span>
                  <span className="font-semibold text-gray-900">{formatCurrency(addonsTotal, room.currency)}</span>
                </div>
              </div>

              {/* Total */}
              <div className="pt-5">
                <div className="flex justify-between items-start">
                  <span className="text-base font-bold text-gray-900">Total</span>
                  <div className="text-right">
                    <p className="text-xl font-bold text-gray-900">{formatCurrency(total, room.currency)}</p>
                    <p className="text-xs text-gray-500">Includes taxes &amp; fees</p>
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
