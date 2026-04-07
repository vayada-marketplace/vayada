'use client'

import { useState, useRef, useEffect } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import Image from 'next/image'
import { useRouter } from '@/i18n/navigation'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import DatePickerCalendar from '@/components/booking/DatePickerCalendar'
import GuestSelector from '@/components/booking/GuestSelector'
import RoomDetailModal from '@/components/booking/RoomDetailModal'
import { useHotel, useRooms, useAddons, useSlug } from '@/contexts/HotelContext'
import { calculateNights, formatDateShort, formatDate } from '@/lib/utils'
import { useCurrency } from '@/contexts/CurrencyContext'
import { getNonRefundableRate } from '@/lib/constants/booking'
import { trackEvent } from '@/services/api/tracking'
import { hotelService } from '@/services/api/hotel'

interface AppliedPromo {
  code: string
  discountType: string
  discountValue: number
}

function PromoPopover({
  open,
  onClose,
  value,
  onChange,
  onApply,
  loading,
  error,
  t,
}: {
  open: boolean
  onClose: () => void
  value: string
  onChange: (v: string) => void
  onApply: () => void
  loading: boolean
  error: string
  t: (key: string) => string
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
      <p className="text-sm font-semibold text-gray-900 mb-2.5">{t('promoTitle')}</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder={t('enterCode')}
          className="flex-1 min-w-0 px-3 py-1.5 rounded-full border border-gray-300 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
        />
        <button
          onClick={onApply}
          disabled={loading || !value.trim()}
          className="px-4 py-1.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-xs disabled:opacity-50"
        >
          {loading ? '...' : t('apply')}
        </button>
      </div>
      {error && (
        <p className="text-[11px] text-red-500 mt-1.5">{error}</p>
      )}
    </div>
  )
}

export default function HomePage() {
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations('home')
  const tc = useTranslations('common')
  const ts = useTranslations('steps')
  const { hotel } = useHotel()
  const { rooms, loading: roomsLoading, roomsLoading: roomsRefetching, refetchRooms } = useRooms()
  const { addons } = useAddons()
  const { formatPrice } = useCurrency()
  const { slug } = useSlug()

  useEffect(() => { trackEvent(slug, 'page_visit') }, [slug])
  const [checkIn, setCheckIn] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().split('T')[0]
  })
  const [checkOut, setCheckOut] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 2)
    return d.toISOString().split('T')[0]
  })
  const [adults, setAdults] = useState(2)
  const [children, setChildren] = useState(0)

  // "Committed" search params — only update when user clicks "Check Availability"
  const [committedCheckIn, setCommittedCheckIn] = useState(checkIn)
  const [committedCheckOut, setCommittedCheckOut] = useState(checkOut)
  const [committedAdults, setCommittedAdults] = useState(2)
  const [committedChildren, setCommittedChildren] = useState(0)

  // Fetch rooms with default dates on initial load so prices reflect seasonal rates
  const [initialFetchDone, setInitialFetchDone] = useState(false)
  useEffect(() => {
    if (!roomsLoading && rooms.length > 0 && !initialFetchDone) {
      setInitialFetchDone(true)
      refetchRooms(checkIn, checkOut, adults)
    }
  }, [roomsLoading, rooms.length])

  // roomCount removed — now computed dynamically per room type
  const [activeFilters, setActiveFilters] = useState<string[]>([])
  const [sortOption, setSortOption] = useState('recommended')
  const [currentStep] = useState(1)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [guestsOpen, setGuestsOpen] = useState(false)
  const [promoOpen, setPromoOpen] = useState(false)
  const [promoCode, setPromoCode] = useState('')
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null)
  const [promoLoading, setPromoLoading] = useState(false)
  const [promoError, setPromoError] = useState('')
  const [imageIndices, setImageIndices] = useState<Record<string, number>>({})
  const [expandedRates, setExpandedRates] = useState<Record<string, string | null>>({})
  const [detailModalIndex, setDetailModalIndex] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const roomsSectionRef = useRef<HTMLDivElement>(null)

  // Auto-expand rate: if only one rate exists, expand it so the
  // "Select This Rate" button is immediately visible without a click.
  // When both rates exist, default to non-refundable expanded.
  useEffect(() => {
    if (rooms.length > 0 && Object.keys(expandedRates).length === 0) {
      const defaults: Record<string, string> = {}
      rooms.forEach((room) => {
        const hasNonRefundable = room.nonRefundableRate != null
        const hasFlexible = room.flexibleRateEnabled !== false
        if (hasNonRefundable && hasFlexible) {
          defaults[room.id] = 'nonrefundable'
        } else if (hasNonRefundable) {
          defaults[room.id] = 'nonrefundable'
        } else if (hasFlexible) {
          defaults[room.id] = 'flexible'
        }
      })
      setExpandedRates(defaults)
    }
  }, [rooms])

  const nights = calculateNights(committedCheckIn, committedCheckOut)

  // Build filter key→label map, only including filters that match at least one room
  const FILTER_ENTRIES = (hotel?.bookingFilters || []).map((key) => ({
    key,
    label: hotel?.customFilters?.[key] || t(key),
  })).filter(({ key, label }) => {
    if (hotel?.filterRooms?.[key]?.length) {
      return rooms.some((room) => hotel.filterRooms?.[key]?.includes(room.id))
    }
    const lower = label.toLowerCase()
    return rooms.some((room) =>
      room.features.some((f) => f.toLowerCase().includes(lower)) ||
      room.amenities.some((a) => a.toLowerCase().includes(lower))
    )
  })
  const FILTERS = FILTER_ENTRIES.map((f) => f.label)

  // Filter rooms using filterRooms mapping (room ID based) with fallback to text matching
  const filteredRooms = (() => {
    let result = activeFilters.length === 0
      ? [...rooms]
      : rooms.filter((room) =>
          activeFilters.every((label) => {
            const entry = FILTER_ENTRIES.find((f) => f.label === label)
            if (entry && hotel?.filterRooms?.[entry.key]?.length) {
              return hotel.filterRooms[entry.key].includes(room.id)
            }
            const lower = label.toLowerCase()
            return (
              room.features.some((f) => f.toLowerCase().includes(lower)) ||
              room.amenities.some((a) => a.toLowerCase().includes(lower))
            )
          })
        )
    if (sortOption === 'priceLow') result.sort((a, b) => a.baseRate - b.baseRate)
    else if (sortOption === 'priceHigh') result.sort((a, b) => b.baseRate - a.baseRate)
    else if (sortOption === 'roomSize') result.sort((a, b) => (b.size || 0) - (a.size || 0))
    return result
  })()

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
        { number: 3, label: ts('confirmation') },
      ]

  const toggleFilter = (filter: string) => {
    setActiveFilters((prev) =>
      prev.includes(filter) ? prev.filter((f) => f !== filter) : [...prev, filter]
    )
  }

  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      {/* Hero Section */}
      <div className="relative h-[520px] w-full">
        <Image
          src={hotel.heroImage}
          alt={hotel.name}
          fill
          className="object-cover"
          priority
          quality={90}
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

        <BookingNavigation />

        {/* Hero Content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-heading italic text-white mb-4">
            {hotel.name}
          </h1>
          <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed">
            {hotel.description}
          </p>
        </div>
      </div>

      {/* Search Bar — sticky on scroll */}
      <div className="sticky top-4 z-30 max-w-5xl mx-auto px-4 -mt-10">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 md:p-6 flex flex-row flex-wrap items-center gap-4 md:gap-6">
          {/* Dates — clickable to open calendar */}
          <div className="relative flex-1 min-w-[120px]">
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
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{t('yourStay')}</p>
                <p className="text-base font-semibold text-gray-900">
                  {formatDateShort(checkIn, locale)} — {formatDate(checkOut, locale)}
                </p>
                <p className="text-sm text-gray-500">{tc('nights', { count: nights })}</p>
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
          <div className="w-px h-12 bg-gray-200" />

          {/* Guests — clickable to open selector */}
          <div className="relative w-auto min-w-[100px]">
            <button
              onClick={() => { setGuestsOpen(!guestsOpen); setCalendarOpen(false) }}
              className="flex items-center gap-3 w-full hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
            >
              <div className="hidden md:flex w-10 h-10 rounded-full bg-primary-50 items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="text-left">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{tc('guests')}</p>
                <p className="text-base font-semibold text-gray-900">
                  {tc('adults', { count: adults })}
                  {children > 0 && `, ${tc('children', { count: children })}`}
                </p>
                <p className="text-sm text-gray-500">{tc('guests')}</p>
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
          <div className="relative flex justify-center md:justify-start w-full md:w-auto">
            {appliedPromo ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 rounded-full text-xs font-semibold">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {appliedPromo.code}
                  {appliedPromo.discountType === 'percentage' ? ` (-${appliedPromo.discountValue}%)` : ` (-${appliedPromo.discountValue})`}
                </span>
                <button
                  onClick={() => { setAppliedPromo(null); setPromoCode(''); setPromoError('') }}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => { setPromoOpen(!promoOpen); setCalendarOpen(false); setGuestsOpen(false) }}
                  className="flex items-center gap-2 text-gray-500 hover:text-primary-600 transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                  </svg>
                  <span className="text-sm font-medium">{t('addPromo')}</span>
                </button>
                {promoOpen && (
                  <PromoPopover
                    open={promoOpen}
                    onClose={() => setPromoOpen(false)}
                    value={promoCode}
                    onChange={(v) => { setPromoCode(v); setPromoError('') }}
                    onApply={async () => {
                      if (!promoCode.trim() || !slug) return
                      setPromoLoading(true)
                      setPromoError('')
                      try {
                        const result = await hotelService.validatePromoCode(slug, promoCode)
                        if (result.valid) {
                          setAppliedPromo({ code: result.code, discountType: result.discountType!, discountValue: result.discountValue! })
                          setPromoOpen(false)
                        } else {
                          setPromoError(result.message)
                        }
                      } catch {
                        setPromoError('Failed to validate promo code')
                      } finally {
                        setPromoLoading(false)
                      }
                    }}
                    loading={promoLoading}
                    error={promoError}
                    t={t}
                  />
                )}
              </>
            )}
          </div>

          {/* Check Availability Button */}
          <button
            onClick={async () => {
              setCalendarOpen(false)
              setGuestsOpen(false)
              setPromoOpen(false)
              setCommittedCheckIn(checkIn)
              setCommittedCheckOut(checkOut)
              setCommittedAdults(adults)
              setCommittedChildren(children)
              setSearching(true)
              roomsSectionRef.current?.scrollIntoView({ behavior: 'smooth' })
              await refetchRooms(checkIn, checkOut, adults)
              setSearching(false)
            }}
            disabled={searching || roomsRefetching}
            className="w-full md:w-auto px-8 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors whitespace-nowrap disabled:opacity-80 flex items-center justify-center gap-2"
          >
            {searching ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {tc('loading')}
              </>
            ) : (
              tc('checkAvailability')
            )}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div ref={roomsSectionRef} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Section Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
          <h2 className="text-2xl md:text-3xl font-heading text-gray-900">
            {t('availableAccommodations')}
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
                    className={`hidden md:inline text-sm font-medium ${
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

        {/* Filters & Sort */}
        <div className="mb-6">
          {FILTERS.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 text-sm text-gray-500 mb-3">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                {t('popularFilters')}
              </div>
              <div className="h-px bg-gray-200 mb-4" />
              <div className="flex items-center gap-2.5 flex-wrap mb-4">
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
            </>
          )}
          <div className="flex justify-end">
            {/* Sort */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
              <select
                value={sortOption}
                onChange={(e) => setSortOption(e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="recommended">{t('recommended')}</option>
                <option value="roomSize">{t('roomSize')}</option>
                <option value="priceLow">{t('priceLowHigh')}</option>
                <option value="priceHigh">{t('priceHighLow')}</option>
              </select>
            </div>
          </div>
        </div>

        {/* Room Cards */}
        <div className="space-y-6">
          {roomsLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-white border border-gray-200 rounded-2xl overflow-hidden animate-pulse">
                <div className="flex flex-col md:flex-row">
                  <div className="w-full md:w-[420px] h-64 md:min-h-[320px] bg-gray-200" />
                  <div className="flex-1 p-5 space-y-4">
                    <div className="h-6 bg-gray-200 rounded w-48" />
                    <div className="h-4 bg-gray-200 rounded w-32" />
                    <div className="flex gap-2">
                      <div className="h-8 bg-gray-200 rounded-full w-24" />
                      <div className="h-8 bg-gray-200 rounded-full w-20" />
                      <div className="h-8 bg-gray-200 rounded-full w-28" />
                    </div>
                    <div className="h-px bg-gray-100" />
                    <div className="h-16 bg-gray-200 rounded-xl" />
                    <div className="h-16 bg-gray-200 rounded-xl" />
                  </div>
                </div>
              </div>
            ))
          ) : filteredRooms.map((room, roomIndex) => {
            const imgIdx = imageIndices[room.id] ?? 0
            const expandedRate = expandedRates[room.id] ?? null
            const totalGuests = committedAdults + committedChildren
            const requiredRooms = Math.ceil(totalGuests / room.maxOccupancy)
            const flexibleTotal = room.baseRate * nights * requiredRooms
            const nonRefundableNightly = getNonRefundableRate(room.baseRate, room.nonRefundableRate)
            const nonRefundableTotal = nonRefundableNightly * nights * requiredRooms
            const discount = Math.round((1 - nonRefundableNightly / room.baseRate) * 100)
            const soldOut = room.remainingRooms < requiredRooms
            const hasLastMinuteDeal = room.lastMinuteDiscountPercent && room.lastMinuteDiscountPercent > 0
            const originalFlexibleTotal = hasLastMinuteDeal && room.originalRate ? room.originalRate * nights * requiredRooms : null

            return (
              <div
                key={room.id}
                className={`bg-white border border-gray-200 rounded-2xl overflow-hidden transition-shadow ${soldOut ? 'opacity-60' : 'hover:shadow-lg'}`}
              >
                <div className="flex flex-col md:flex-row">
                  {/* Image Carousel — fills full card height */}
                  <div className="relative w-full h-64 md:w-[420px] md:min-h-[320px] md:h-auto flex-shrink-0 cursor-pointer overflow-hidden" onClick={() => { trackEvent(slug, 'viewed_room', { roomId: room.id }); setDetailModalIndex(roomIndex) }}>
                    <Image
                      src={room.images[imgIdx]}
                      alt={room.name}
                      fill
                      className="object-cover"
                    />
                    {soldOut && (
                      <div className="absolute inset-0 bg-black/30 z-20 flex items-center justify-center">
                        <span className="bg-white text-gray-900 text-sm font-bold px-5 py-2 rounded-full shadow">{t('soldOut')}</span>
                      </div>
                    )}
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
                      <div className="absolute bottom-3 left-3 right-3 flex gap-1.5 z-10 overflow-x-auto">
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
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-xl font-bold text-gray-900">
                            {requiredRooms > 1 && <span className="text-primary-600">{requiredRooms}× </span>}
                            {room.name}
                          </h3>
                          {room.category && (
                            <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 border border-primary-200">
                              {room.category}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-4 text-sm text-gray-500 mt-1">
                          <span className="flex items-center gap-1">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
                            {room.size} m&sup2;
                          </span>
                          <span className="flex items-center gap-1">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            {t('upToGuests', { count: room.maxOccupancy })}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => { trackEvent(slug, 'viewed_room', { roomId: room.id }); setDetailModalIndex(roomIndex) }}
                        className="flex items-center gap-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-full px-4 py-1.5 hover:bg-gray-50 transition-colors flex-shrink-0"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        {t('viewDetails')}
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
                          {tc('more', { count: room.features.length - 4 })}
                        </span>
                      )}
                    </div>

                    {/* Last-minute deal badge */}
                    {hasLastMinuteDeal && (
                      <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                        <span className="text-[11px] font-bold bg-amber-500 text-white px-2 py-0.5 rounded">-{room.lastMinuteDiscountPercent}%</span>
                        <span className="text-sm font-medium text-amber-800">Last-minute deal</span>
                        {originalFlexibleTotal && (
                          <span className="ml-auto text-sm text-gray-400 line-through">{formatPrice(originalFlexibleTotal, room.currency)}</span>
                        )}
                      </div>
                    )}

                    {/* Rate Options */}
                    <div className="border-t border-gray-100 pt-4">
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">{t('rateOptions')}</p>
                      <div className="space-y-3">
                        {/* Non-Refundable Rate */}
                        {room.nonRefundableRate != null && (
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
                              <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              <div className="text-left">
                                <p className="text-sm font-bold text-gray-900 flex items-center gap-2">
                                  {t('nonRefundableRate')}
                                  {discount > 0 && <span className="text-[10px] font-bold bg-primary-600 text-white px-1.5 py-0.5 rounded">-{discount}% OFF</span>}
                                </p>
                                <p className="text-xs text-gray-500">{t('nonRefundableDesc')}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="text-right">
                                <p className="text-lg font-bold text-gray-900">{formatPrice(nonRefundableTotal, room.currency)}</p>
                                <p className="text-xs text-gray-500">{t('perNightly', { price: formatPrice(nonRefundableNightly, room.currency) })}</p>
                              </div>
                              <svg className={`w-5 h-5 text-gray-400 transition-transform flex-shrink-0 ${expandedRate === 'nonrefundable' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>
                          {expandedRate === 'nonrefundable' && (
                            <div className="px-4 pb-4">
                              {room.benefits && room.benefits.length > 0 && (
                                <>
                                  <p className="text-xs font-medium text-gray-500 mb-2">{t('includes')}</p>
                                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4">
                                    {room.benefits.map((benefit) => (
                                      <p key={benefit} className="flex items-center gap-2 text-sm text-gray-600">
                                        <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                        {benefit}
                                      </p>
                                    ))}
                                  </div>
                                </>
                              )}
                              <button
                                onClick={() => {
                                  const params = `room=${room.id}&checkIn=${committedCheckIn}&checkOut=${committedCheckOut}&adults=${committedAdults}&children=${committedChildren}&rooms=${requiredRooms}&rateType=nonrefundable${appliedPromo ? `&promoCode=${appliedPromo.code}` : ''}`
                                  router.push(hasAddons ? `/addons?${params}` : `/book?${params}`)
                                }}
                                disabled={soldOut}
                                className="w-full py-2.5 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {soldOut ? t('soldOut') : t('selectThisRate')}
                              </button>
                            </div>
                          )}
                        </div>
                        )}

                        {/* Flexible Rate */}
                        {room.flexibleRateEnabled !== false && (
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
                              <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                              <div className="text-left">
                                <p className="text-sm font-bold text-gray-900">{t('flexibleRate')}</p>
                                <p className="text-xs text-gray-500">{t('flexibleDesc')}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="text-right">
                                <p className="text-lg font-bold text-gray-900">{formatPrice(flexibleTotal, room.currency)}</p>
                                <p className="text-xs text-gray-500">{t('perNightly', { price: formatPrice(room.baseRate, room.currency) })}</p>
                              </div>
                              <svg className={`w-5 h-5 text-gray-400 transition-transform flex-shrink-0 ${expandedRate === 'flexible' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>
                          {expandedRate === 'flexible' && (
                            <div className="px-4 pb-4">
                              {room.benefits && room.benefits.length > 0 && (
                                <>
                                  <p className="text-xs font-medium text-gray-500 mb-2">{t('includes')}</p>
                                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4">
                                    {room.benefits.map((benefit) => (
                                      <p key={benefit} className="flex items-center gap-2 text-sm text-gray-600">
                                        <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                        {benefit}
                                      </p>
                                    ))}
                                  </div>
                                </>
                              )}
                              <button
                                onClick={() => {
                                  const params = `room=${room.id}&checkIn=${committedCheckIn}&checkOut=${committedCheckOut}&adults=${committedAdults}&children=${committedChildren}&rooms=${requiredRooms}&rateType=flexible${appliedPromo ? `&promoCode=${appliedPromo.code}` : ''}`
                                  router.push(hasAddons ? `/addons?${params}` : `/book?${params}`)
                                }}
                                disabled={soldOut}
                                className="w-full py-2.5 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {soldOut ? t('soldOut') : t('selectThisRate')}
                              </button>
                            </div>
                          )}
                        </div>
                        )}
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
          room={filteredRooms[detailModalIndex]}
          nights={nights}
          open={true}
          onClose={() => setDetailModalIndex(null)}
          currentIndex={detailModalIndex}
          totalRooms={filteredRooms.length}
          onPrev={() => setDetailModalIndex(detailModalIndex === 0 ? filteredRooms.length - 1 : detailModalIndex - 1)}
          onNext={() => setDetailModalIndex(detailModalIndex === filteredRooms.length - 1 ? 0 : detailModalIndex + 1)}
          onSelectRate={(rateType) => {
            const room = filteredRooms[detailModalIndex]
            const modalRequiredRooms = Math.ceil((committedAdults + committedChildren) / room.maxOccupancy)
            const params = `room=${room.id}&checkIn=${committedCheckIn}&checkOut=${committedCheckOut}&adults=${committedAdults}&children=${committedChildren}&rooms=${modalRequiredRooms}&rateType=${rateType}${appliedPromo ? `&promoCode=${appliedPromo.code}` : ''}`
            router.push(hasAddons ? `/addons?${params}` : `/book?${params}`)
          }}
        />
      )}

      <BookingFooter />
    </div>
  )
}
