'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import BookingFooter from '@/components/layout/BookingFooter'
import HeroSection from '@/components/booking/HeroSection'
import StepIndicator from '@/components/booking/StepIndicator'
import AddonDetailModal from '@/components/booking/AddonDetailModal'
import { ADDON_CATEGORIES } from '@/lib/mock/addons'
import { useHotel, useAddons } from '@/contexts/HotelContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { calculateNights } from '@/lib/utils'

export default function AddonsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('addons')
  const tc = useTranslations('common')
  const ts = useTranslations('steps')
  const { hotel } = useHotel()
  const { addons } = useAddons()
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency()
  const [activeCategory, setActiveCategory] = useState('all')
  const [selections, setSelections] = useState<Record<string, number>>({})
  const [selectedDates, setSelectedDates] = useState<Record<string, string[]>>({})
  const [detailIndex, setDetailIndex] = useState<number | null>(null)
  const currentStep = 2

  const checkIn = searchParams.get('checkIn') || ''
  const checkOut = searchParams.get('checkOut') || ''
  const adultsParam = parseInt(searchParams.get('adults') || '2')
  const nights = calculateNights(checkIn, checkOut)

  // Generate array of stay dates (each night of the stay)
  const stayDates = (() => {
    if (!checkIn || !checkOut) return []
    const dates: string[] = []
    const start = new Date(checkIn)
    const end = new Date(checkOut)
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split('T')[0])
    }
    return dates
  })()

  const STEPS = [
    { number: 1, label: ts('rooms') },
    { number: 2, label: ts('addons') },
    { number: 3, label: ts('details') },
    { number: 4, label: ts('payment') },
  ]

  const availableCategories = ADDON_CATEGORIES.filter(
    (cat) => cat.key === 'all' || addons.some((a) => a.category === cat.key)
  )

  const filteredAddons =
    activeCategory === 'all'
      ? addons
      : addons.filter((a) => a.category === activeCategory)

  const selectedIds = Object.keys(selections)

  const getMaxQuantity = (addon: { perNight?: boolean; perPerson?: boolean }) => {
    if (addon.perNight) return nights
    if (addon.perPerson) return Math.max(1, adultsParam)
    return 10
  }

  const toggleAddon = (id: string) => {
    setSelections((prev) => {
      if (prev[id] !== undefined) {
        const next = { ...prev }
        delete next[id]
        setSelectedDates((pd) => { const nd = { ...pd }; delete nd[id]; return nd })
        return next
      }
      const addon = addons.find(a => a.id === id)
      if (addon?.perNight) {
        setSelectedDates((pd) => ({ ...pd, [id]: [...stayDates] }))
      }
      return { ...prev, [id]: addon?.perNight ? nights : 1 }
    })
  }

  const toggleDate = (addonId: string, date: string) => {
    setSelectedDates((prev) => {
      const current = prev[addonId] || []
      const updated = current.includes(date)
        ? current.filter((d) => d !== date)
        : [...current, date].sort()
      if (updated.length === 0) return prev // must keep at least 1 day
      setSelections((ps) => ({ ...ps, [addonId]: updated.length }))
      return { ...prev, [addonId]: updated }
    })
  }

  const setQuantity = (id: string, qty: number, addon: { perNight?: boolean; perPerson?: boolean }) => {
    const max = getMaxQuantity(addon)
    const clamped = Math.max(1, Math.min(qty, max))
    setSelections((prev) => ({ ...prev, [id]: clamped }))
    // For perNight addons, adjust selected dates to match new quantity
    if (addon.perNight) {
      setSelectedDates((prev) => {
        const current = prev[id] || [...stayDates]
        if (clamped >= current.length) {
          // Adding dates: fill from stayDates in order
          const result = [...current]
          for (const d of stayDates) {
            if (result.length >= clamped) break
            if (!result.includes(d)) result.push(d)
          }
          return { ...prev, [id]: result.sort() }
        } else {
          // Removing dates: keep the first N
          return { ...prev, [id]: current.slice(0, clamped) }
        }
      })
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <HeroSection heroImage={hotel.heroImage} hotelName={hotel.name} description={hotel.description} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-8 gap-6">
          <div>
            <h1 className="text-3xl font-heading text-gray-900 mb-1">{t('title')}</h1>
            <p className="text-gray-500">{t('subtitle')}</p>
          </div>

          <StepIndicator steps={STEPS} currentStep={currentStep} />
        </div>

        {/* Category Filters */}
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          {availableCategories.map((cat) => (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${
                activeCategory === cat.key
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Add-on Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
          {filteredAddons.map((addon, idx) => {
            const isAdded = selections[addon.id] !== undefined
            return (
              <div
                key={addon.id}
                className={`bg-white border rounded-2xl overflow-hidden transition-shadow hover:shadow-lg cursor-pointer ${
                  isAdded ? 'border-primary-500 shadow-md' : 'border-gray-200'
                }`}
                onClick={() => setDetailIndex(idx)}
              >
                <div className="relative h-48">
                  <Image src={addon.image} alt={addon.name} fill className="object-cover" />
                </div>
                <div className="p-4">
                  <h3 className="text-base font-bold text-gray-900 mb-1">{addon.name}</h3>
                  <p className="text-sm text-gray-500 mb-4 line-clamp-2">{addon.description}</p>
                  <div className="flex items-center justify-between">
                    <p className="text-lg font-bold text-gray-900">
                      {formatPrice(addon.price, addon.currency)}
                      {addon.perNight && <span className="text-xs font-normal text-gray-500"> /night</span>}
                      {addon.perPerson && <span className="text-xs font-normal text-gray-500"> /person</span>}
                    </p>
                    {isAdded ? (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => setQuantity(addon.id, selections[addon.id] - 1, addon)}
                          disabled={selections[addon.id] <= 1}
                          className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" /></svg>
                        </button>
                        <span className="w-10 text-center text-sm font-semibold text-gray-900">
                          {addon.perNight
                            ? `${selections[addon.id]}/${nights}`
                            : addon.perPerson
                              ? `${selections[addon.id]}/${adultsParam}`
                              : selections[addon.id]}
                        </span>
                        <button
                          onClick={() => setQuantity(addon.id, selections[addon.id] + 1, addon)}
                          disabled={selections[addon.id] >= getMaxQuantity(addon)}
                          className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                        </button>
                        <button
                          onClick={() => toggleAddon(addon.id)}
                          className="ml-1 w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 hover:border-red-200 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleAddon(addon.id) }}
                        className="px-5 py-1.5 rounded-full text-sm font-semibold border-2 transition-colors bg-white text-gray-700 border-gray-300 hover:border-gray-400"
                      >
                        {t('add')}
                      </button>
                    )}
                  </div>
                  {/* Date toggles for perNight addons */}
                  {isAdded && addon.perNight && stayDates.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-100" onClick={(e) => e.stopPropagation()}>
                      <p className="text-xs text-gray-500 mb-2">{t('selectDays')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {stayDates.map((date) => {
                          const isSelected = (selectedDates[addon.id] || []).includes(date)
                          const d = new Date(date)
                          const dayLabel = d.toLocaleDateString(undefined, { weekday: 'short' })
                          const dateLabel = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                          return (
                            <button
                              key={date}
                              onClick={() => toggleDate(addon.id, date)}
                              disabled={isSelected && (selectedDates[addon.id] || []).length <= 1}
                              className={`px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                                isSelected
                                  ? 'bg-primary-50 text-primary-700 border-primary-300'
                                  : 'bg-gray-50 text-gray-400 border-gray-200 hover:border-gray-300'
                              } disabled:cursor-not-allowed`}
                            >
                              <span className="block leading-tight">{dayLabel}</span>
                              <span className="block leading-tight text-[10px]">{dateLabel}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Selected Add-ons Summary */}
        {selectedIds.length > 0 && (
          <div className="bg-gradient-to-br from-primary-50 to-white border border-primary-100 rounded-2xl p-6 mb-8">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <h3 className="text-lg font-bold text-gray-900">
                {t('yourSelections', { count: selectedIds.length })}
              </h3>
            </div>
            <div className="space-y-3 mb-5">
              {addons.filter((a) => selections[a.id] !== undefined).map((addon) => {
                const qty = selections[addon.id]
                // For perPerson addons, qty already counts the people opting in (the on-card "/person" stepper); don't multiply by room occupancy.
                const computedPrice = addon.price * qty
                return (
                <div key={addon.id} className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-100">
                  <div className="flex items-center gap-3">
                    <div className="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0">
                      <Image src={addon.image} alt={addon.name} fill className="object-cover" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{addon.name}</p>
                      <p className="text-xs text-gray-500">
                        {addon.perNight
                          ? `${qty} / ${tc('nights', { count: nights })}`
                          : addon.perPerson
                            ? `${qty} / ${adultsParam} ${tc('guests').toLowerCase()}`
                            : qty > 1 ? `${tc('qty')}: ${qty}` : addon.description}
                        {addon.perPerson ? ` · ${tc('perPerson')}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <p className="text-sm font-bold text-gray-900">
                      {formatPrice(computedPrice, addon.currency)}
                    </p>
                    <button
                      onClick={() => toggleAddon(addon.id)}
                      className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 hover:border-red-200 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>
                )
              })}
            </div>
            <div className="flex items-center justify-between pt-4 border-t border-primary-100">
              <p className="text-sm text-gray-500">{t('addonsTotal')}</p>
              <p className="text-xl font-bold text-gray-900">
                {(() => {
                  // Sum line totals in displayed currency so total = sum of shown per-line prices
                  // (avoids "$25 × 3 = $76" conversion rounding mismatch).
                  let total = 0
                  for (const addon of addons) {
                    if (!selectedIds.includes(addon.id)) continue
                    const qty = selections[addon.id] ?? 1
                    total += convertAndRound(addon.price * qty, addon.currency)
                  }
                  return formatPrice(total, selectedCurrency)
                })()}
              </p>
            </div>
          </div>
        )}

        {/* Bottom Action Bar */}
        <div className="flex items-center justify-between border-t border-gray-200 pt-6">
          <button
            onClick={() => {
              const params = new URLSearchParams()
              if (checkIn) params.set('checkIn', checkIn)
              if (checkOut) params.set('checkOut', checkOut)
              params.set('adults', String(adultsParam))
              const childrenParam = parseInt(searchParams.get('children') || '0')
              if (childrenParam > 0) params.set('children', String(childrenParam))
              const qs = params.toString()
              router.push(qs ? `/?${qs}` : '/')
            }}
            className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {t('backToRooms')}
          </button>
          <button
            onClick={() => {
              const params = new URLSearchParams(searchParams.toString())
              if (selectedIds.length > 0) {
                params.set('addons', selectedIds.map((id) => {
                  const qty = selections[id]
                  return qty > 1 ? `${id}:${qty}` : id
                }).join(','))
                // Store selected dates for perNight addons
                if (Object.keys(selectedDates).length > 0) {
                  sessionStorage.setItem('addonDates', JSON.stringify(selectedDates))
                }
              }
              router.push(`/book?${params.toString()}`)
            }}
            className="px-8 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm"
          >
            {t('proceedToGuest')}
          </button>
        </div>
      </div>

      {detailIndex !== null && filteredAddons[detailIndex] && (
        <AddonDetailModal
          addon={filteredAddons[detailIndex]}
          open
          onClose={() => setDetailIndex(null)}
          isAdded={selections[filteredAddons[detailIndex].id] !== undefined}
          onToggle={() => toggleAddon(filteredAddons[detailIndex].id)}
          currentIndex={detailIndex}
          totalAddons={filteredAddons.length}
          onPrev={() => setDetailIndex(detailIndex > 0 ? detailIndex - 1 : filteredAddons.length - 1)}
          onNext={() => setDetailIndex(detailIndex < filteredAddons.length - 1 ? detailIndex + 1 : 0)}
        />
      )}

      <BookingFooter />
    </div>
  )
}
