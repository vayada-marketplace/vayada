'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import { MOCK_ADDONS, ADDON_CATEGORIES } from '@/lib/mock/addons'
import { MOCK_HOTEL } from '@/lib/mock/hotel'
import { formatCurrency } from '@/lib/utils'

const STEPS = [
  { number: 1, label: 'Rooms' },
  { number: 2, label: 'Add-ons' },
  { number: 3, label: 'Details' },
  { number: 4, label: 'Payment' },
]

export default function AddonsPage() {
  const router = useRouter()
  const [activeCategory, setActiveCategory] = useState('all')
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())
  const currentStep = 2

  const filteredAddons =
    activeCategory === 'all'
      ? MOCK_ADDONS
      : MOCK_ADDONS.filter((a) => a.category === activeCategory)

  const toggleAddon = (id: string) => {
    setAddedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Hero Section */}
      <div className="relative h-[420px] w-full">
        <Image
          src={MOCK_HOTEL.heroImage}
          alt={MOCK_HOTEL.name}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

        <BookingNavigation />

        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-serif italic text-white mb-4">
            {MOCK_HOTEL.name}
          </h1>
          <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed">
            {MOCK_HOTEL.description}
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-8 gap-6">
          <div>
            <h1 className="text-3xl font-serif text-gray-900 mb-1">Enhance Your Stay</h1>
            <p className="text-gray-500">Customize your experience with our premium services and activities.</p>
          </div>

          {/* Step Indicator */}
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
                  <span
                    className={`text-sm font-medium ${
                      step.number <= currentStep ? 'text-gray-900' : 'text-gray-400'
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <div
                    className={`w-8 md:w-12 h-px mx-2 ${
                      step.number < currentStep ? 'bg-primary-600' : 'bg-gray-300'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Category Filters */}
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          {ADDON_CATEGORIES.map((cat) => (
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
          {filteredAddons.map((addon) => {
            const isAdded = addedIds.has(addon.id)
            return (
              <div
                key={addon.id}
                className={`bg-white border rounded-2xl overflow-hidden transition-shadow hover:shadow-lg ${
                  isAdded ? 'border-primary-500 shadow-md' : 'border-gray-200'
                }`}
              >
                <div className="relative h-48">
                  <Image src={addon.image} alt={addon.name} fill className="object-cover" />
                </div>
                <div className="p-4">
                  <h3 className="text-base font-bold text-gray-900 mb-1">{addon.name}</h3>
                  <p className="text-sm text-gray-500 mb-4 line-clamp-2">{addon.description}</p>
                  <div className="flex items-center justify-between">
                    <p className="text-lg font-bold text-gray-900">{formatCurrency(addon.price, addon.currency)}</p>
                    <button
                      onClick={() => toggleAddon(addon.id)}
                      className={`px-5 py-1.5 rounded-full text-sm font-semibold border-2 transition-colors ${
                        isAdded
                          ? 'bg-primary-600 text-white border-primary-600 hover:bg-primary-700'
                          : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
                      }`}
                    >
                      {isAdded ? 'Added' : 'Add'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Selected Add-ons Summary */}
        {addedIds.size > 0 && (
          <div className="bg-gradient-to-br from-primary-50 to-white border border-primary-100 rounded-2xl p-6 mb-8">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <h3 className="text-lg font-bold text-gray-900">
                Your Selections ({addedIds.size})
              </h3>
            </div>
            <div className="space-y-3 mb-5">
              {MOCK_ADDONS.filter((a) => addedIds.has(a.id)).map((addon) => (
                <div key={addon.id} className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-100">
                  <div className="flex items-center gap-3">
                    <div className="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0">
                      <Image src={addon.image} alt={addon.name} fill className="object-cover" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{addon.name}</p>
                      <p className="text-xs text-gray-500">{addon.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <p className="text-sm font-bold text-gray-900">{formatCurrency(addon.price, addon.currency)}</p>
                    <button
                      onClick={() => toggleAddon(addon.id)}
                      className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 hover:border-red-200 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between pt-4 border-t border-primary-100">
              <p className="text-sm text-gray-500">Add-ons total</p>
              <p className="text-xl font-bold text-gray-900">
                {formatCurrency(
                  MOCK_ADDONS.filter((a) => addedIds.has(a.id)).reduce((sum, a) => sum + a.price, 0),
                  'EUR'
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
            Back to Rooms
          </button>
          <button
            onClick={() => router.push('/book')}
            className="px-8 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm"
          >
            Proceed to Guest Information
          </button>
        </div>
      </div>

      <BookingFooter />
    </div>
  )
}
