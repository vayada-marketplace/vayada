'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import DatePickerCalendar from '@/components/booking/DatePickerCalendar'
import GuestSelector from '@/components/booking/GuestSelector'
import RoomDetailModal from '@/components/booking/RoomDetailModal'
import { MOCK_HOTEL } from '@/lib/mock/hotel'
import { MOCK_ROOMS } from '@/lib/mock/rooms'
import { formatCurrency, calculateNights } from '@/lib/utils'

function PromoPopover({
  open,
  onClose,
  value,
  onChange,
}: {
  open: boolean
  onClose: () => void
  value: string
  onChange: (v: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 bg-white rounded-xl shadow-xl border border-gray-100 p-4 z-50 w-64"
    >
      <p className="text-sm font-semibold text-gray-900 mb-2.5">Have a promo code?</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder="Enter code"
          className="flex-1 min-w-0 px-3 py-1.5 rounded-full border border-gray-300 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
        />
        <button
          onClick={onClose}
          className="px-4 py-1.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-xs"
        >
          Apply
        </button>
      </div>
    </div>
  )
}

const FILTERS = [
  'Include Breakfast',
  'Free Cancellation',
  'Pay At Hotel',
  'Best Rated',
  'Mountain View',
]

const STEPS = [
  { number: 1, label: 'Rooms' },
  { number: 2, label: 'Add-ons' },
  { number: 3, label: 'Details' },
  { number: 4, label: 'Payment' },
]

export default function HomePage() {
  const router = useRouter()
  const [checkIn, setCheckIn] = useState('2026-02-13')
  const [checkOut, setCheckOut] = useState('2026-02-18')
  const [adults, setAdults] = useState(2)
  const [children, setChildren] = useState(0)
  const [rooms] = useState(1)
  const [activeFilters, setActiveFilters] = useState<string[]>([])
  const [currentStep] = useState(1)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [guestsOpen, setGuestsOpen] = useState(false)
  const [promoOpen, setPromoOpen] = useState(false)
  const [promoCode, setPromoCode] = useState('')
  const [imageIndices, setImageIndices] = useState<Record<string, number>>({})
  const [expandedRates, setExpandedRates] = useState<Record<string, string | null>>({})
  const [detailModalIndex, setDetailModalIndex] = useState<number | null>(null)

  const nights = calculateNights(checkIn, checkOut)

  const toggleFilter = (filter: string) => {
    setActiveFilters((prev) =>
      prev.includes(filter) ? prev.filter((f) => f !== filter) : [...prev, filter]
    )
  }

  const formatDisplayDate = (dateStr: string) => {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

  const formatDisplayDateFull = (dateStr: string) => {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Hero Section */}
      <div className="relative h-[520px] w-full">
        <Image
          src={MOCK_HOTEL.heroImage}
          alt={MOCK_HOTEL.name}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

        <BookingNavigation />

        {/* Hero Content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-serif italic text-white mb-4">
            {MOCK_HOTEL.name}
          </h1>
          <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed">
            {MOCK_HOTEL.description}
          </p>
        </div>
      </div>

      {/* Search Bar — sticky on scroll */}
      <div className="sticky top-4 z-30 max-w-5xl mx-auto px-4 -mt-10">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 md:p-6 flex flex-col md:flex-row items-center gap-4 md:gap-6">
          {/* Dates — clickable to open calendar */}
          <div className="relative flex-1 min-w-0">
            <button
              onClick={() => { setCalendarOpen(!calendarOpen); setGuestsOpen(false) }}
              className="flex items-center gap-3 w-full text-left hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
            >
              <div className="w-10 h-10 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Your Stay</p>
                <p className="text-base font-semibold text-gray-900">
                  {formatDisplayDate(checkIn)} — {formatDisplayDateFull(checkOut)}
                </p>
                <p className="text-sm text-gray-500">{nights} night{nights !== 1 ? 's' : ''}</p>
              </div>
            </button>
            <DatePickerCalendar
              open={calendarOpen}
              onClose={() => setCalendarOpen(false)}
              checkIn={checkIn}
              checkOut={checkOut}
              onSelect={(ci, co) => {
                setCheckIn(ci)
                setCheckOut(co)
              }}
            />
          </div>

          {/* Divider */}
          <div className="hidden md:block w-px h-12 bg-gray-200" />

          {/* Guests — clickable to open selector */}
          <div className="relative">
            <button
              onClick={() => { setGuestsOpen(!guestsOpen); setCalendarOpen(false) }}
              className="flex items-center gap-3 hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
            >
              <div className="w-10 h-10 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="text-left">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Guests</p>
                <p className="text-base font-semibold text-gray-900">
                  {adults} Adult{adults !== 1 ? 's' : ''}
                  {children > 0 && `, ${children} Child${children !== 1 ? 'ren' : ''}`}
                </p>
                <p className="text-sm text-gray-500">{rooms} Room</p>
              </div>
            </button>
            <GuestSelector
              open={guestsOpen}
              onClose={() => setGuestsOpen(false)}
              adults={adults}
              children={children}
              onUpdate={(a, c) => { setAdults(a); setChildren(c) }}
            />
          </div>

          {/* Divider */}
          <div className="hidden md:block w-px h-12 bg-gray-200" />

          {/* Promo */}
          <div className="relative">
            <button
              onClick={() => { setPromoOpen(!promoOpen); setCalendarOpen(false); setGuestsOpen(false) }}
              className="flex items-center gap-2 text-gray-500 hover:text-primary-600 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <span className="text-sm font-medium">Add promo</span>
            </button>
            {promoOpen && (
              <PromoPopover
                open={promoOpen}
                onClose={() => setPromoOpen(false)}
                value={promoCode}
                onChange={setPromoCode}
              />
            )}
          </div>

          {/* Check Availability Button */}
          <button className="w-full md:w-auto px-8 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors whitespace-nowrap">
            Check Availability
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Section Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
          <h2 className="text-2xl md:text-3xl font-serif text-gray-900">
            Available Accommodations
          </h2>

          {/* Step Indicator */}
          <div className="flex items-center gap-2">
            {STEPS.map((step, index) => (
              <div key={step.number} className="flex items-center">
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      step.number === currentStep
                        ? 'bg-primary-600 text-white'
                        : step.number < currentStep
                        ? 'bg-success-500 text-white'
                        : 'bg-gray-200 text-gray-500'
                    }`}
                  >
                    {step.number}
                  </div>
                  <span
                    className={`text-sm font-medium ${
                      step.number === currentStep ? 'text-gray-900' : 'text-gray-400'
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <div className="w-8 md:w-12 h-px bg-gray-300 mx-2" />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div className="mb-6">
          <div className="flex items-center gap-1.5 text-sm text-gray-500 mb-3">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Popular Filters
          </div>
          <div className="h-px bg-gray-200 mb-4" />
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 flex-wrap">
              {FILTERS.map((filter) => (
                <button
                  key={filter}
                  onClick={() => toggleFilter(filter)}
                  className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                    activeFilters.includes(filter)
                      ? 'border-gray-900 text-gray-900'
                      : 'border-gray-300 text-gray-600 hover:border-gray-400'
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>

            {/* Sort */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
              <select className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500">
                <option>Recommended</option>
                <option>Room Size</option>
                <option>Price: Low to High</option>
                <option>Price: High to Low</option>
              </select>
            </div>
          </div>
        </div>

        {/* Room Cards */}
        <div className="space-y-6">
          {MOCK_ROOMS.map((room, roomIndex) => {
            const imgIdx = imageIndices[room.id] ?? 0
            const expandedRate = expandedRates[room.id] ?? null
            const flexibleTotal = room.baseRate * nights
            const nonRefundableNightly = Math.round(room.baseRate * 0.85)
            const nonRefundableTotal = nonRefundableNightly * nights

            return (
              <div
                key={room.id}
                className="bg-white border border-gray-200 rounded-2xl overflow-hidden hover:shadow-lg transition-shadow"
              >
                <div className="flex flex-col md:flex-row">
                  {/* Image Carousel — fills full card height */}
                  <div className="relative w-full md:w-[420px] md:min-h-[320px] flex-shrink-0 cursor-pointer" onClick={() => setDetailModalIndex(roomIndex)}>
                    <Image
                      src={room.images[imgIdx]}
                      alt={room.name}
                      fill
                      className="object-cover"
                    />
                    {/* Prev/Next Arrows */}
                    {room.images.length > 1 && (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setImageIndices((prev) => ({
                              ...prev,
                              [room.id]: imgIdx === 0 ? room.images.length - 1 : imgIdx - 1,
                            }))
                          }}
                          className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors z-10"
                        >
                          <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setImageIndices((prev) => ({
                              ...prev,
                              [room.id]: imgIdx === room.images.length - 1 ? 0 : imgIdx + 1,
                            }))
                          }}
                          className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors z-10"
                        >
                          <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        </button>
                      </>
                    )}
                    {/* Thumbnail strip */}
                    {room.images.length > 1 && (
                      <div className="absolute bottom-3 left-3 right-3 flex gap-1.5 z-10">
                        {room.images.map((img, i) => (
                          <button
                            key={i}
                            onClick={(e) => {
                              e.stopPropagation()
                              setImageIndices((prev) => ({ ...prev, [room.id]: i }))
                            }}
                            className={`relative h-12 w-16 rounded-md overflow-hidden border-2 transition-colors flex-shrink-0 ${i === imgIdx ? 'border-white' : 'border-transparent opacity-70 hover:opacity-100'}`}
                          >
                            <Image src={img} alt="" fill className="object-cover" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Room Details + Rates */}
                  <div className="flex-1 p-5 flex flex-col">
                    {/* Header row */}
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <h3 className="text-xl font-bold text-gray-900">{room.name}</h3>
                        <div className="flex items-center gap-4 text-sm text-gray-500 mt-1">
                          <span className="flex items-center gap-1">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
                            {room.size} m&sup2;
                          </span>
                          <span className="flex items-center gap-1">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            Up to {room.maxOccupancy} guests
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => setDetailModalIndex(roomIndex)}
                        className="flex items-center gap-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-full px-4 py-1.5 hover:bg-gray-50 transition-colors flex-shrink-0"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        View Details
                      </button>
                    </div>

                    {/* Feature pills */}
                    <div className="flex flex-wrap gap-2 mb-4">
                      {room.features.slice(0, 4).map((feature) => (
                        <span
                          key={feature}
                          className="inline-flex items-center gap-1.5 text-sm text-gray-700 border border-gray-200 px-3 py-1 rounded-full"
                        >
                          <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          {feature}
                        </span>
                      ))}
                      {room.features.length > 4 && (
                        <span className="inline-flex items-center text-sm text-gray-500 border border-gray-200 px-3 py-1 rounded-full">
                          +{room.features.length - 4} more
                        </span>
                      )}
                    </div>

                    {/* Rate Options */}
                    <div className="border-t border-gray-100 pt-4">
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Rate Options</p>
                      <div className="space-y-3">
                        {/* Flexible Rate */}
                        <div className={`rounded-xl border-2 overflow-hidden transition-colors ${expandedRate === 'flexible' ? 'border-primary-500' : 'border-gray-200'}`}>
                          <button
                            onClick={() =>
                              setExpandedRates((prev) => ({
                                ...prev,
                                [room.id]: prev[room.id] === 'flexible' ? null : 'flexible',
                              }))
                            }
                            className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-gray-50/50 transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              {/* Refresh/clock icon */}
                              <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                              <div className="text-left">
                                <p className="text-sm font-bold text-gray-900">Flexible Rate</p>
                                <p className="text-xs text-gray-500">Free cancellation until 7 days before</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="text-right">
                                <p className="text-lg font-bold text-gray-900">{formatCurrency(flexibleTotal, room.currency)}</p>
                                <p className="text-xs text-gray-500">{formatCurrency(room.baseRate, room.currency)}/per</p>
                              </div>
                              <svg className={`w-5 h-5 text-gray-400 transition-transform flex-shrink-0 ${expandedRate === 'flexible' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>
                          {expandedRate === 'flexible' && (
                            <div className="px-4 pb-4">
                              <p className="text-xs font-medium text-gray-500 mb-2">Includes:</p>
                              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4">
                                <p className="flex items-center gap-2 text-sm text-gray-600">
                                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                  Daily breakfast for {adults}
                                </p>
                                <p className="flex items-center gap-2 text-sm text-gray-600">
                                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                  Welcome drink
                                </p>
                                <p className="flex items-center gap-2 text-sm text-gray-600">
                                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                  Free WiFi
                                </p>
                                <p className="flex items-center gap-2 text-sm text-gray-600">
                                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                  Airport transfer
                                </p>
                              </div>
                              <button
                                onClick={() => router.push('/addons')}
                                className="w-full py-2.5 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors text-sm"
                              >
                                Select This Rate
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Non-Refundable Rate */}
                        <div className={`rounded-xl border-2 overflow-hidden transition-colors ${expandedRate === 'nonrefundable' ? 'border-primary-500' : 'border-gray-200'}`}>
                          <button
                            onClick={() =>
                              setExpandedRates((prev) => ({
                                ...prev,
                                [room.id]: prev[room.id] === 'nonrefundable' ? null : 'nonrefundable',
                              }))
                            }
                            className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-gray-50/50 transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              {/* X icon */}
                              <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              <div className="text-left">
                                <p className="text-sm font-bold text-gray-900 flex items-center gap-2">
                                  Non-Refundable Rate
                                  <span className="text-[10px] font-bold bg-primary-600 text-white px-1.5 py-0.5 rounded">-15% OFF</span>
                                </p>
                                <p className="text-xs text-gray-500">Non-refundable</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="text-right">
                                <p className="text-lg font-bold text-gray-900">{formatCurrency(nonRefundableTotal, room.currency)}</p>
                                <p className="text-xs text-gray-500">{formatCurrency(nonRefundableNightly, room.currency)}/per</p>
                              </div>
                              <svg className={`w-5 h-5 text-gray-400 transition-transform flex-shrink-0 ${expandedRate === 'nonrefundable' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>
                          {expandedRate === 'nonrefundable' && (
                            <div className="px-4 pb-4">
                              <p className="text-xs font-medium text-gray-500 mb-2">Includes:</p>
                              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4">
                                <p className="flex items-center gap-2 text-sm text-gray-600">
                                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                  Daily breakfast for {adults}
                                </p>
                                <p className="flex items-center gap-2 text-sm text-gray-600">
                                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                  Welcome drink
                                </p>
                                <p className="flex items-center gap-2 text-sm text-gray-600">
                                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                  Free WiFi
                                </p>
                                <p className="flex items-center gap-2 text-sm text-gray-600">
                                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                  Airport transfer
                                </p>
                              </div>
                              <button
                                onClick={() => router.push('/addons')}
                                className="w-full py-2.5 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors text-sm"
                              >
                                Select This Rate
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Room Detail Modal */}
      {detailModalIndex !== null && (
        <RoomDetailModal
          room={MOCK_ROOMS[detailModalIndex]}
          nights={nights}
          open={true}
          onClose={() => setDetailModalIndex(null)}
          currentIndex={detailModalIndex}
          totalRooms={MOCK_ROOMS.length}
          onPrev={() => setDetailModalIndex(detailModalIndex === 0 ? MOCK_ROOMS.length - 1 : detailModalIndex - 1)}
          onNext={() => setDetailModalIndex(detailModalIndex === MOCK_ROOMS.length - 1 ? 0 : detailModalIndex + 1)}
        />
      )}

      <BookingFooter />
    </div>
  )
}
