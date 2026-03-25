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
import { calculateAddonTotal } from '@/lib/constants/booking'

export default function AddonsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('addons')
  const tc = useTranslations('common')
  const ts = useTranslations('steps')
  const { hotel } = useHotel()
  const { addons } = useAddons()
  const { formatPrice } = useCurrency()
  const [activeCategory, setActiveCategory] = useState('all')
  const [selections, setSelections] = useState<Record<string, number>>({})
  const [detailIndex, setDetailIndex] = useState<number | null>(null)
  const currentStep = 2

  const checkIn = searchParams.get('checkIn') || ''
  const checkOut = searchParams.get('checkOut') || ''
  const adultsParam = parseInt(searchParams.get('adults') || '2')
  const nights = calculateNights(checkIn, checkOut)

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

  const MAX_QUANTITY = 10

  const toggleAddon = (id: string) => {
    setSelections((prev) => {
      if (prev[id] !== undefined) {
        const next = { ...prev }
        delete next[id]
        return next
      }
      return { ...prev, [id]: 1 }
    })
  }

  const setQuantity = (id: string, qty: number) => {
    setSelections((prev) => ({
      ...prev,
      [id]: Math.max(1, Math.min(qty, MAX_QUANTITY)),
    }))
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
                          onClick={() => setQuantity(addon.id, selections[addon.id] - 1)}
                          disabled={selections[addon.id] <= 1}
                          className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" /></svg>
                        </button>
                        <span className="w-8 text-center text-sm font-semibold text-gray-900">
                          {selections[addon.id]}
                        </span>
                        <button
                          onClick={() => setQuantity(addon.id, selections[addon.id] + 1)}
                          disabled={selections[addon.id] >= MAX_QUANTITY}
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
                let computedPrice = addon.price
                if (addon.perPerson) computedPrice *= adultsParam
                if (addon.perNight) computedPrice *= nights
                computedPrice *= qty
                return (
                <div key={addon.id} className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-100">
                  <div className="flex items-center gap-3">
                    <div className="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0">
                      <Image src={addon.image} alt={addon.name} fill className="object-cover" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{addon.name}</p>
                      <p className="text-xs text-gray-500">
                        {qty > 1 ? `${tc('qty')}: ${qty}` : addon.description}
                        {addon.perPerson && qty > 1 ? ` · ${tc('perPerson')}` : ''}
                        {addon.perNight ? ` · ${tc('nights', { count: nights })}` : ''}
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
                {formatPrice(
                  calculateAddonTotal(addons, selectedIds, adultsParam, nights, selections),
                  hotel.currency
                )}
              </p>
            </div>
          </div>
        )}

        {/* Bottom Action Bar */}
        <div className="flex items-center justify-between border-t border-gray-200 pt-6">
          <button
            onClick={() => router.push('/')}
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
