'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { XMarkIcon, PlusIcon, CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { RoomTypeCreate, RoomTypeUpdate } from '@/services/rooms'
import ImageUpload from '@/components/ImageUpload'
import { getCurrencySymbol } from '@/lib/utils'

const BED_TYPES = ['King Bed', 'Queen Bed', 'Double Bed', 'Twin Bed', 'Single Bed', 'Bunk Bed', 'Sofa Bed']

const ROOM_CATEGORIES = ['Standard', 'Deluxe', 'Superior', 'Suite', 'Villa', 'Bungalow', 'Studio', 'Penthouse']

const FEATURE_CATEGORIES = [
  {
    name: 'VIEWS & LOCATION',
    items: [
      { label: 'Sea view', emoji: '\uD83C\uDF0A' },
      { label: 'Ocean view', emoji: '\uD83C\uDF05' },
      { label: 'Mountain view', emoji: '\u26F0\uFE0F' },
      { label: 'Garden view', emoji: '\uD83C\uDF3F' },
      { label: 'Pool view', emoji: '\uD83C\uDFCA' },
      { label: 'Beachfront', emoji: '\uD83C\uDFD6\uFE0F' },
      { label: 'Forest view', emoji: '\uD83C\uDF32' },
      { label: 'City view', emoji: '\uD83C\uDFD9\uFE0F' },
      { label: 'Lake view', emoji: '\uD83C\uDFDE\uFE0F' },
      { label: 'River view', emoji: '\uD83C\uDFDE\uFE0F' },
    ],
  },
  {
    name: 'OUTDOOR & RECREATION',
    items: [
      { label: 'Private Pool', emoji: '\uD83C\uDFCA' },
      { label: 'Shared Pool', emoji: '\uD83C\uDFCA' },
      { label: 'Hot tub', emoji: '\uD83D\uDEC1' },
      { label: 'BBQ', emoji: '\uD83D\uDD25' },
      { label: 'Outdoor dining area', emoji: '\uD83C\uDF7D\uFE0F' },
      { label: 'Private terrace', emoji: '\uD83C\uDF05' },
      { label: 'Balcony', emoji: '\uD83C\uDFE0' },
      { label: 'Garden', emoji: '\uD83C\uDF3F' },
      { label: 'Rooftop access', emoji: '\uD83C\uDFD9\uFE0F' },
    ],
  },
  {
    name: 'SPACE & TYPE',
    items: [
      { label: 'Entire villa', emoji: '\uD83C\uDFE1' },
      { label: 'Entire apartment', emoji: '\uD83C\uDFE2' },
      { label: 'Private entrance', emoji: '\uD83D\uDEAA' },
      { label: 'Penthouse', emoji: '\uD83C\uDFD9\uFE0F' },
      { label: 'Duplex', emoji: '\uD83C\uDFE0' },
      { label: 'Studio', emoji: '\uD83D\uDECB\uFE0F' },
    ],
  },
]

const AMENITY_CATEGORIES = [
  {
    name: 'Internet & Tech',
    items: ['Free WiFi', 'Flat-screen TV', 'Smart TV', 'Netflix / Streaming', 'Work desk', 'Laptop-friendly workspace'],
  },
  {
    name: 'Kitchen',
    items: ['Mini Bar', 'Refrigerator', 'Microwave', 'Kitchenware', 'Electric kettle', 'Stovetop', 'Dining table'],
  },
  {
    name: 'Bathroom',
    items: ['Bath', 'Shower', 'Free toiletries', 'Hairdryer', 'Toilet', 'Toilet paper', 'Hot Tub', 'Towels', 'Slippers', 'Bathrobe'],
  },
  {
    name: 'Climate & Comfort',
    items: ['Air conditioning', 'Heating', 'Fan', 'Fireplace'],
  },
  {
    name: 'Bedroom',
    items: ['Extra pillows', 'Blackout curtains', 'Wardrobe', 'Bed linen'],
  },
  {
    name: 'Laundry',
    items: ['Washing machine', 'Dryer', 'Iron/Ironing board', 'Clothes rack'],
  },
  {
    name: 'Safety & Access',
    items: ['Safe', '24hr Security', 'Smoke detector', 'First aid kit', 'Fire extinguisher'],
  },
  {
    name: 'Services',
    items: ['Room service', 'Daily housekeeping', 'Concierge', 'Parking', 'Non-smoking', 'Adults-Only', 'Outdoor furniture'],
  },
]


type RoomTab = 'details' | 'pricing' | 'media'
const ROOM_TABS: { key: RoomTab; label: string }[] = [
  { key: 'details', label: 'Room Details' },
  { key: 'pricing', label: 'Pricing & Rates' },
  { key: 'media', label: 'Images & Amenities' },
]

const SELECT_ARROW_STYLE = {
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat' as const,
  backgroundPosition: 'right 12px center',
}

interface RoomTypeFormProps {
  form: RoomTypeCreate | RoomTypeUpdate
  onChange: (form: any) => void
  onSubmit: (e: React.FormEvent) => void
  saving: boolean
  error?: string
  success?: string
  submitLabel?: string
  cancelHref?: string
}

function bedsToSummary(beds: { type: string; count: number }[]): string {
  return beds.map(b => `${b.count} ${b.type}`).join(', ')
}

function parseBedType(bedType: string): { type: string; count: number }[] {
  if (!bedType || !bedType.trim()) return [{ type: 'King Bed', count: 1 }]
  const parts = bedType.split(',').map(s => s.trim()).filter(Boolean)
  return parts.map(part => {
    const match = part.match(/^(\d+)\s+(.+)$/)
    if (match) return { type: match[2], count: parseInt(match[1]) }
    return { type: part, count: 1 }
  })
}

export default function RoomTypeForm({
  form,
  onChange,
  onSubmit,
  saving,
  error,
  success,
  submitLabel = 'Save',
  cancelHref = '/rooms',
}: RoomTypeFormProps) {
  const [activeTab, setActiveTab] = useState<RoomTab>('details')
  const [amenityInput, setAmenityInput] = useState('')
  const [featureInput, setFeatureInput] = useState('')
  const [expandedAmenityCategories, setExpandedAmenityCategories] = useState<string[]>(['Internet & Tech'])
  const [customAmenityInputs, setCustomAmenityInputs] = useState<Record<string, string>>({})
  const [customAmenitiesByCategory, setCustomAmenitiesByCategory] = useState<Record<string, string[]>>({})
  const [beds, setBeds] = useState<{ type: string; count: number }[]>(() => parseBedType(form.bedType || ''))
  const [operatingPeriods, setOperatingPeriods] = useState<{ from: string; to: string }[]>(
    form.operatingPeriods?.length ? form.operatingPeriods.map((p: { from: string; to: string }) => ({
      from: p.from && p.from.length > 5 ? p.from.slice(5) : p.from,
      to: p.to && p.to.length > 5 ? p.to.slice(5) : p.to,
    })) : [{ from: '01-01', to: '12-31' }]
  )
  const [seasons, setSeasons] = useState<{ name: string; tier: string; from: string; to: string; rate: string; minStay: number }[]>(
    (form.seasons || []).map(s => ({
      ...s,
      from: s.from && s.from.length > 5 ? s.from.slice(5) : s.from,
      to: s.to && s.to.length > 5 ? s.to.slice(5) : s.to,
    }))
  )
  const [previewMonth, setPreviewMonth] = useState(() => new Date())
  const [weekendSurcharge, setWeekendSurcharge] = useState(form.weekendSurcharge || '+0%')
  const [cancellationPolicy, setCancellationPolicy] = useState(form.cancellationPolicy || 'Free until 7 days before')
  const [flexibleRateEnabled, setFlexibleRateEnabled] = useState(form.flexibleRateEnabled ?? true)
  const [nonRefundableEnabled, setNonRefundableEnabled] = useState(form.nonRefundableEnabled ?? false)
  const [nonRefundableDiscount, setNonRefundableDiscount] = useState(form.nonRefundableDiscount ?? 10)
  const [dailyRates, setDailyRates] = useState<Record<string, number>>(form.dailyRates || {})
  const [editingDay, setEditingDay] = useState<string | null>(null)
  const [editingDayValue, setEditingDayValue] = useState('')
  const benefits: string[] = form.benefits || []
  const [category, setCategory] = useState(form.category || '')
  const [bedrooms, setBedrooms] = useState(1)
  const [bathrooms, setBathrooms] = useState(1)

  // Sync beds -> form.bedType
  useEffect(() => {
    const summary = bedsToSummary(beds)
    if (summary !== form.bedType) {
      onChange({ ...form, bedType: summary })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beds])

  // Sync pricing fields -> form
  useEffect(() => {
    onChange({
      ...form,
      operatingPeriods,
      seasons,
      weekendSurcharge,
      cancellationPolicy,
      flexibleRateEnabled,
      nonRefundableEnabled,
      nonRefundableDiscount,
      dailyRates,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operatingPeriods, seasons, weekendSurcharge, cancellationPolicy, flexibleRateEnabled, nonRefundableEnabled, nonRefundableDiscount, dailyRates])

  const updateForm = (updates: Partial<RoomTypeCreate>) => {
    const updated = { ...form, ...updates }
    onChange(updated)
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const DAYS_IN_MONTH = [31,29,31,30,31,30,31,31,30,31,30,31]

  const getYearPercent = (mmdd: string): number => {
    if (!mmdd) return 0
    const [mm, dd] = mmdd.split('-').map(Number)
    if (!mm || !dd) return 0
    // Day of year out of 366 (leap year for max days)
    let dayOfYear = 0
    for (let i = 0; i < mm - 1; i++) dayOfYear += DAYS_IN_MONTH[i]
    dayOfYear += dd
    return (dayOfYear / 366) * 100
  }

  const overlappingSeasonIndices = (() => {
    const indices = new Set<number>()
    for (let i = 0; i < seasons.length; i++) {
      for (let j = i + 1; j < seasons.length; j++) {
        const a = seasons[i], b = seasons[j]
        if (a.from && a.to && b.from && b.to && a.from <= b.to && b.from <= a.to) {
          indices.add(i)
          indices.add(j)
        }
      }
    }
    return indices
  })()

  // Detect gaps between seasons (MM-DD format)
  const seasonGaps = (() => {
    const valid = seasons.filter(s => s.from && s.to)
    if (valid.length < 2) return []
    const sorted = [...valid].sort((a, b) => a.from.localeCompare(b.from))
    const gaps: { from: string; to: string }[] = []
    const mmddToDoy = (mmdd: string) => { const [m, d] = mmdd.split('-').map(Number); return DAYS_IN_MONTH.slice(0, m - 1).reduce((a, b) => a + b, 0) + d }
    const doyToMmdd = (doy: number) => { let m = 0; let rem = doy; while (m < 12 && rem > DAYS_IN_MONTH[m]) { rem -= DAYS_IN_MONTH[m]; m++ } return `${String(m + 1).padStart(2, '0')}-${String(rem).padStart(2, '0')}` }
    for (let i = 0; i < sorted.length - 1; i++) {
      const endDoy = mmddToDoy(sorted[i].to)
      const nextStartDoy = mmddToDoy(sorted[i + 1].from)
      if (endDoy + 1 < nextStartDoy) {
        gaps.push({
          from: doyToMmdd(endDoy + 1),
          to: doyToMmdd(nextStartDoy - 1),
        })
      }
    }
    return gaps
  })()

  const isInSeasonGap = (dateStr: string) => {
    const mmdd = dateStr.slice(5) // extract MM-DD from YYYY-MM-DD
    return seasonGaps.some(g => mmdd >= g.from && mmdd <= g.to)
  }

  const getSeasonForDate = (day: number) => {
    const month = previewMonth.getMonth()
    const mmdd = `${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    for (const s of seasons) {
      if (s.from && s.to && mmdd >= s.from && mmdd <= s.to) return s
    }
    return null
  }

  const isInOperatingPeriod = (day: number) => {
    const month = previewMonth.getMonth()
    const mmdd = `${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return operatingPeriods.some(p => {
      if (!p.from || !p.to) return false
      // Handle cross-year periods (e.g. 11-01 to 02-28)
      if (p.from > p.to) return mmdd >= p.from || mmdd <= p.to
      return mmdd >= p.from && mmdd <= p.to
    })
  }

  const tierColors: Record<string, string> = {
    Low: 'text-emerald-600 bg-emerald-50 border-emerald-200',
    Mid: 'text-blue-600 bg-blue-50 border-blue-200',
    High: 'text-blue-800 bg-blue-100 border-blue-200',
    Peak: 'text-indigo-700 bg-indigo-100 border-indigo-200',
  }

  const tierDotColors: Record<string, string> = {
    Low: 'bg-emerald-400',
    Mid: 'bg-blue-400',
    High: 'bg-blue-600',
    Peak: 'bg-indigo-500',
  }

  return (
    <form onSubmit={onSubmit}>
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-[11px] text-red-700 font-medium">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-[11px] text-green-700 font-medium">
          {success}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-6 mb-6 border-b border-gray-200">
        {ROOM_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`pb-2.5 text-[12px] font-medium transition-colors relative ${
              activeTab === tab.key
                ? 'text-gray-900'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {tab.label}
            {activeTab === tab.key && (
              <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gray-900 rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Tab 1: Room Details */}
      {activeTab === 'details' && (
        <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Room Type Basics</h3>
            <span className="text-[11px] font-medium text-red-500">Required</span>
          </div>

          {/* Room Type Name */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">
                Room Type Name <span className="text-red-500">*</span>
              </label>
            </div>
            <input
              type="text"
              value={form.name || ''}
              onChange={(e) => updateForm({ name: e.target.value })}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              placeholder="e.g. Two-Bedroom Villa"
            />
            <p className="text-[10px] text-gray-400 mt-1">Shown as the bold heading on the room card and in the booking summary</p>
          </div>

          {/* Beds */}
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <label className="text-[12px] font-semibold text-gray-900">Beds</label>
            </div>
            <p className="text-[10px] text-gray-400 mb-2">Add all bed types available in this room</p>
            <div className="space-y-2">
              {beds.map((bed, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={bed.type}
                    onChange={(e) => {
                      const updated = [...beds]
                      updated[idx] = { ...updated[idx], type: e.target.value }
                      setBeds(updated)
                    }}
                    className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                    style={SELECT_ARROW_STYLE}
                  >
                    {BED_TYPES.map((bt) => (
                      <option key={bt} value={bt}>{bt}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={bed.count}
                    onChange={(e) => {
                      const updated = [...beds]
                      updated[idx] = { ...updated[idx], count: Math.max(1, Number(e.target.value)) }
                      setBeds(updated)
                    }}
                    className="w-16 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                  />
                  {beds.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setBeds(beds.filter((_, i) => i !== idx))}
                      className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <XMarkIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setBeds([...beds, { type: 'King Bed', count: 1 }])}
              className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-gray-700 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <PlusIcon className="w-3.5 h-3.5" /> Add Bed
            </button>
          </div>

          {/* Max Occupancy */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">
                Max Occupancy <span className="text-red-500">*</span>
              </label>
            </div>
            <input
              type="number"
              min={1}
              value={form.maxOccupancy ?? 2}
              onChange={(e) => updateForm({ maxOccupancy: Math.max(1, Number(e.target.value)) })}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
            />
            <p className="text-[10px] text-gray-400 mt-1">Shows as &quot;Up to X guests&quot; on room card</p>
          </div>

          {/* Bedrooms, Bathrooms, Room Size, Total Rooms */}
          <div className="grid grid-cols-4 gap-4 items-start">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Bedrooms</label>
              </div>
              <input
                type="number"
                min={0}
                value={bedrooms}
                onChange={(e) => setBedrooms(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Bathrooms</label>
              </div>
              <input
                type="number"
                min={0}
                value={bathrooms}
                onChange={(e) => setBathrooms(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Room Size (m&sup2;) <span className="text-red-500">*</span></label>
              </div>
              <input
                type="number"
                min={1}
                max={1000}
                value={form.size ?? 1}
                onChange={(e) => updateForm({ size: Math.max(1, Math.min(parseInt(e.target.value) || 1, 1000)) })}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                placeholder="50"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Total Rooms <span className="text-red-500">*</span></label>
              </div>
              <input
                type="number"
                min={1}
                value={form.totalRooms ?? 2}
                onChange={(e) => updateForm({ totalRooms: Math.max(1, Number(e.target.value)) })}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
              <p className="text-[10px] text-gray-400 mt-1 pl-3">Number of units available for this room type</p>
            </div>
          </div>

          {/* Room Description */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">Room Description</label>
            </div>
            <textarea
              value={form.description || ''}
              onChange={(e) => updateForm({ description: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 resize-vertical"
              placeholder="The private pool is the standout feature of this villa. The air-conditioned villa has 2 bedrooms and 2 bathrooms..."
            />
            <p className="text-[10px] text-gray-400 mt-1">Shown in the &quot;View Details&quot; modal when a guest clicks to see more</p>
          </div>

          {/* Room Category Tag */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">Room Category Tag</label>
              <span className="text-[10px] text-gray-400">(shown to guests in Booking Engine)</span>
            </div>
            <select
              value={category}
              onChange={(e) => { setCategory(e.target.value); updateForm({ category: e.target.value }) }}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
              style={SELECT_ARROW_STYLE}
            >
              <option value="">Select category</option>
              {ROOM_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          {/* Sort Order & Active */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Sort Order</label>
              </div>
              <input
                type="number"
                value={form.sortOrder ?? 0}
                onChange={(e) => updateForm({ sortOrder: parseInt(e.target.value) || 0 })}
                min={0}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
            </div>
            <div className="flex items-end col-span-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <button
                  type="button"
                  onClick={() => updateForm({ isActive: !(form.isActive ?? true) })}
                  className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${(form.isActive ?? true) ? 'bg-primary-500' : 'bg-gray-300'}`}
                >
                  <div className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${(form.isActive ?? true) ? 'left-[20px]' : 'left-[2px]'}`} />
                </button>
                <span className="text-[12px] font-semibold text-gray-900">Active</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Pricing & Rates */}
      {activeTab === 'pricing' && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left column: 4 sections */}
          <div className="lg:col-span-3 space-y-8">
            {/* Section 1: When are you open? */}
            <div>
              <div className="flex items-start gap-3 mb-1">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">1</span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">When are you open?</h3>
                  <p className="text-[11px] text-gray-400">Operating periods repeat every year — dates outside are automatically closed</p>
                </div>
              </div>
              <div className="ml-9">
                {/* Timeline Bar */}
                <div className="mb-4">
                  <div className="flex text-[9px] text-gray-400 mb-1">
                    {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m => (
                      <span key={m} className="flex-1 text-center">{m}</span>
                    ))}
                  </div>
                  <div className="relative h-7 bg-gray-100 rounded-full overflow-hidden">
                    {operatingPeriods.map((period, idx) => {
                      const start = period.from ? getYearPercent(period.from) : 0
                      const end = period.to ? getYearPercent(period.to) : 100
                      const colors = ['bg-primary-200', 'bg-amber-200', 'bg-emerald-200', 'bg-rose-200']
                      const color = colors[idx % colors.length]
                      // Handle cross-year periods (e.g. Nov to Feb)
                      if (period.from && period.to && period.from > period.to) {
                        return (
                          <React.Fragment key={idx}>
                            <div className={`absolute top-0 h-full ${color}`} style={{ left: `${start}%`, width: `${100 - start}%` }} />
                            <div className={`absolute top-0 h-full ${color} flex items-center justify-center`} style={{ left: '0%', width: `${end}%` }}>
                              <span className="text-[9px] font-semibold text-gray-700 truncate px-1">Period {idx + 1}</span>
                            </div>
                          </React.Fragment>
                        )
                      }
                      const width = Math.max(end - start, 1)
                      return (
                        <div
                          key={idx}
                          className={`absolute top-0 h-full ${color} flex items-center justify-center`}
                          style={{ left: `${start}%`, width: `${width}%` }}
                        >
                          <span className="text-[9px] font-semibold text-gray-700 truncate px-1">
                            {idx === 0 && width > 90 ? 'Year Round' : `Period ${idx + 1}`}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-gray-200 bg-gray-50/50 px-5 py-4 space-y-3">
                  {operatingPeriods.map((period, idx) => {
                    const fromMonth = period.from ? parseInt(period.from.split('-')[0]) : 0
                    const fromDay = period.from ? parseInt(period.from.split('-')[1]) : 0
                    const toMonth = period.to ? parseInt(period.to.split('-')[0]) : 0
                    const toDay = period.to ? parseInt(period.to.split('-')[1]) : 0
                    const isInvalid = period.from && period.to && period.to < period.from
                    const updatePeriod = (field: 'from' | 'to', month: number, day: number) => {
                      const updated = [...operatingPeriods]
                      const m = month || (day ? 1 : 0)
                      const maxDay = m ? DAYS_IN_MONTH[m - 1] : 31
                      const d = day || (month ? 1 : 0)
                      const clampedDay = Math.min(d, maxDay)
                      updated[idx] = { ...updated[idx], [field]: (m || d) ? `${String(m || 1).padStart(2, '0')}-${String(clampedDay || 1).padStart(2, '0')}` : '' }
                      setOperatingPeriods(updated)
                    }
                    return (
                      <div key={idx}>
                        <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1 flex-1">
                          <select
                            value={fromDay}
                            onChange={(e) => updatePeriod('from', fromMonth, parseInt(e.target.value) || 0)}
                            className="w-[52px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          >
                            <option value={0}>—</option>
                            {Array.from({ length: fromMonth ? DAYS_IN_MONTH[fromMonth - 1] : 31 }, (_, i) => (
                              <option key={i + 1} value={i + 1}>{String(i + 1).padStart(2, '0')}</option>
                            ))}
                          </select>
                          <select
                            value={fromMonth}
                            onChange={(e) => updatePeriod('from', parseInt(e.target.value) || 0, fromDay)}
                            className="w-[68px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          >
                            <option value={0}>—</option>
                            {MONTHS.map((m, i) => (
                              <option key={m} value={i + 1}>{m}</option>
                            ))}
                          </select>
                        </div>
                        <span className="text-[11px] text-gray-400">to</span>
                        <div className="flex items-center gap-1 flex-1">
                          <select
                            value={toDay}
                            onChange={(e) => updatePeriod('to', toMonth, parseInt(e.target.value) || 0)}
                            className={`w-[52px] px-1.5 py-2 bg-white border rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent ${isInvalid ? 'border-red-400' : 'border-gray-200'}`}
                          >
                            <option value={0}>—</option>
                            {Array.from({ length: toMonth ? DAYS_IN_MONTH[toMonth - 1] : 31 }, (_, i) => (
                              <option key={i + 1} value={i + 1}>{String(i + 1).padStart(2, '0')}</option>
                            ))}
                          </select>
                          <select
                            value={toMonth}
                            onChange={(e) => updatePeriod('to', parseInt(e.target.value) || 0, toDay)}
                            className={`w-[68px] px-1.5 py-2 bg-white border rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent ${isInvalid ? 'border-red-400' : 'border-gray-200'}`}
                          >
                            <option value={0}>—</option>
                            {MONTHS.map((m, i) => (
                              <option key={m} value={i + 1}>{m}</option>
                            ))}
                          </select>
                        </div>
                        {operatingPeriods.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setOperatingPeriods(operatingPeriods.filter((_, i) => i !== idx))}
                            className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <XMarkIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      {isInvalid && (
                        <p className="ml-0 mt-1 text-[10px] text-red-500">End date must be after start date</p>
                      )}
                    </div>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => setOperatingPeriods([...operatingPeriods, { from: '', to: '' }])}
                    className="inline-flex items-center gap-1.5 text-[11px] text-gray-600 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <PlusIcon className="w-3.5 h-3.5" /> Add period
                  </button>
                </div>
              </div>
            </div>

            {/* Section 2: Seasonal pricing */}
            <div>
              <div className="flex items-start gap-3 mb-1">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">2</span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">How does your pricing change across the year?</h3>
                  <p className="text-[11px] text-gray-400">Draw seasons on your operating period, then set a base rate per season</p>
                </div>
              </div>
              <div className="ml-9">
                {seasons.length === 0 ? (
                  <div className="rounded-xl border border-gray-200 bg-gray-50/50 px-5 py-6 text-center">
                    <p className="text-[11px] text-gray-400">No seasons yet. Add one below.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {seasons.map((season, idx) => {
                      const dayCount = season.from && season.to
                        ? (() => { const [fm, fd] = season.from.split('-').map(Number); const [tm, td] = season.to.split('-').map(Number); const fromDoy = DAYS_IN_MONTH.slice(0, fm - 1).reduce((a, b) => a + b, 0) + fd; const toDoy = DAYS_IN_MONTH.slice(0, tm - 1).reduce((a, b) => a + b, 0) + td; return Math.max(0, toDoy - fromDoy); })()
                        : 0
                      return (
                        <div key={idx} className={`rounded-xl border px-4 py-3 ${overlappingSeasonIndices.has(idx) ? 'border-red-300 bg-red-50/50' : 'border-gray-200 bg-gray-50/50'}`}>
                          <div className="flex items-center gap-2 mb-2">
                            <input
                              type="text"
                              value={season.name}
                              onChange={(e) => { const u = [...seasons]; u[idx] = { ...u[idx], name: e.target.value }; setSeasons(u) }}
                              placeholder="Season name"
                              className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 placeholder-gray-400"
                            />
                            <div className="flex items-center gap-2 shrink-0">
                              <select
                                value={season.tier}
                                onChange={(e) => { const u = [...seasons]; u[idx] = { ...u[idx], tier: e.target.value }; setSeasons(u) }}
                                className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border appearance-none cursor-pointer ${tierColors[season.tier] || 'text-gray-600 bg-gray-100 border-gray-200'}`}
                                style={{ ...SELECT_ARROW_STYLE, backgroundPosition: 'right 8px center', paddingRight: '20px' }}
                              >
                                <option value="Low">Low</option>
                                <option value="Mid">Mid</option>
                                <option value="High">High</option>
                                <option value="Peak">Peak</option>
                              </select>
                              <button type="button" onClick={() => setSeasons(seasons.filter((_, i) => i !== idx))} className="p-1 text-gray-400 hover:text-red-500 transition-colors">
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                              </button>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {(() => {
                              const sFromMonth = season.from ? parseInt(season.from.split('-')[0]) : 0
                              const sFromDay = season.from ? parseInt(season.from.split('-')[1]) : 0
                              const sToMonth = season.to ? parseInt(season.to.split('-')[0]) : 0
                              const sToDay = season.to ? parseInt(season.to.split('-')[1]) : 0
                              const updateSeasonDate = (field: 'from' | 'to', month: number, day: number) => {
                                const u = [...seasons]
                                const m = month || (day ? 1 : 0)
                                const maxDay = m ? DAYS_IN_MONTH[m - 1] : 31
                                const d = day || (month ? 1 : 0)
                                const clampedDay = Math.min(d, maxDay)
                                u[idx] = { ...u[idx], [field]: (m || d) ? `${String(m || 1).padStart(2, '0')}-${String(clampedDay || 1).padStart(2, '0')}` : '' }
                                setSeasons(u)
                              }
                              return (
                                <>
                                  <div className="flex items-center gap-1">
                                    <select value={sFromDay} onChange={(e) => updateSeasonDate('from', sFromMonth, parseInt(e.target.value) || 0)} className="w-[52px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent">
                                      <option value={0}>—</option>
                                      {Array.from({ length: sFromMonth ? DAYS_IN_MONTH[sFromMonth - 1] : 31 }, (_, i) => (
                                        <option key={i + 1} value={i + 1}>{String(i + 1).padStart(2, '0')}</option>
                                      ))}
                                    </select>
                                    <select value={sFromMonth} onChange={(e) => updateSeasonDate('from', parseInt(e.target.value) || 0, sFromDay)} className="w-[68px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent">
                                      <option value={0}>—</option>
                                      {MONTHS.map((m, i) => (
                                        <option key={m} value={i + 1}>{m}</option>
                                      ))}
                                    </select>
                                  </div>
                                  <span className="text-[11px] text-gray-400">to</span>
                                  <div className="flex items-center gap-1">
                                    <select value={sToDay} onChange={(e) => updateSeasonDate('to', sToMonth, parseInt(e.target.value) || 0)} className="w-[52px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent">
                                      <option value={0}>—</option>
                                      {Array.from({ length: sToMonth ? DAYS_IN_MONTH[sToMonth - 1] : 31 }, (_, i) => (
                                        <option key={i + 1} value={i + 1}>{String(i + 1).padStart(2, '0')}</option>
                                      ))}
                                    </select>
                                    <select value={sToMonth} onChange={(e) => updateSeasonDate('to', parseInt(e.target.value) || 0, sToDay)} className="w-[68px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent">
                                      <option value={0}>—</option>
                                      {MONTHS.map((m, i) => (
                                        <option key={m} value={i + 1}>{m}</option>
                                      ))}
                                    </select>
                                  </div>
                                  {dayCount > 0 && <span className="text-[10px] text-gray-400 shrink-0">{dayCount}d</span>}
                                </>
                              )
                            })()}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                {overlappingSeasonIndices.size > 0 && (
                  <p className="mt-2 text-[11px] text-red-600 font-medium">Season date ranges must not overlap. Please adjust the highlighted seasons.</p>
                )}
                {seasonGaps.length > 0 && (
                  <div className="mt-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                    <p className="text-[11px] text-amber-700 font-medium mb-1">Gaps detected — the following dates have no season and therefore no price:</p>
                    <ul className="list-disc list-inside text-[11px] text-amber-600">
                      {seasonGaps.map((gap, i) => {
                        const fmt = (mmdd: string) => { const [m, d] = mmdd.split('-').map(Number); return `${d} ${MONTHS[m - 1]}` }
                        const fromDoy = (() => { const [m, d] = gap.from.split('-').map(Number); return DAYS_IN_MONTH.slice(0, m - 1).reduce((a, b) => a + b, 0) + d })()
                        const toDoy = (() => { const [m, d] = gap.to.split('-').map(Number); return DAYS_IN_MONTH.slice(0, m - 1).reduce((a, b) => a + b, 0) + d })()
                        const days = toDoy - fromDoy + 1
                        return (
                          <li key={i}>
                            {fmt(gap.from)}{gap.from !== gap.to ? ` – ${fmt(gap.to)}` : ''} ({days} day{days > 1 ? 's' : ''} uncovered)
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setSeasons([...seasons, { name: '', tier: '', from: '', to: '', rate: '', minStay: 1 }])}
                  className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-600 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <PlusIcon className="w-3.5 h-3.5" /> Add season
                </button>

                {/* Set rates per season table */}
                {seasons.length > 0 && (
                  <div className="mt-4 rounded-xl border border-gray-200 bg-white overflow-hidden">
                    <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                      <span className="text-[11px] font-semibold text-gray-700">Set rates per season</span>
                    </div>
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="text-left px-4 py-2 text-gray-500 font-medium">Season</th>
                          <th className="text-left px-4 py-2 text-gray-500 font-medium">Flex Rate</th>
                          <th className="text-left px-4 py-2 text-gray-500 font-medium">Min Stay</th>
                        </tr>
                      </thead>
                      <tbody>
                        {seasons.map((season, idx) => {
                          return (
                            <tr key={idx} className="border-b border-gray-50">
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-2">
                                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${tierColors[season.tier] || 'text-gray-600 bg-gray-100'}`}>
                                    {season.tier || 'Low'}
                                  </span>
                                  {season.name
                                    ? <span className="text-[12px] text-gray-700">{season.name}</span>
                                    : <span className="text-gray-300">&mdash;</span>
                                  }
                                </div>
                              </td>
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-1">
                                  <span className="text-gray-400">{getCurrencySymbol(form.currency || 'EUR')}</span>
                                  <input
                                    type="number"
                                    value={season.rate}
                                    onChange={(e) => { const u = [...seasons]; u[idx] = { ...u[idx], rate: e.target.value }; setSeasons(u) }}
                                    className={`w-16 px-2 py-1 bg-gray-50 border rounded text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 ${!season.rate || Number(season.rate) <= 0 ? 'border-red-400' : 'border-gray-200'}`}
                                    placeholder="0"
                                    min="1"
                                    required
                                  />
                                  {(!season.rate || Number(season.rate) <= 0) && (
                                    <span className="text-[10px] text-red-500">Required</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-2.5">
                                <div className="inline-flex items-center gap-0 border border-gray-200 rounded-lg overflow-hidden">
                                  <button
                                    type="button"
                                    onClick={() => { const u = [...seasons]; u[idx] = { ...u[idx], minStay: Math.max(1, (u[idx].minStay || 1) - 1) }; setSeasons(u) }}
                                    className="px-1.5 py-1 text-gray-500 hover:bg-gray-100 transition-colors text-[11px] font-medium"
                                  >
                                    &minus;
                                  </button>
                                  <span className="px-2 py-1 text-[11px] font-semibold text-gray-900 bg-white min-w-[28px] text-center">
                                    {season.minStay || 1}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => { const u = [...seasons]; u[idx] = { ...u[idx], minStay: (u[idx].minStay || 1) + 1 }; setSeasons(u) }}
                                    className="px-1.5 py-1 text-gray-500 hover:bg-gray-100 transition-colors text-[11px] font-medium"
                                  >
                                    +
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Section 3: Rate plans */}
            <div>
              <div className="flex items-start gap-3 mb-1">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">3</span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">What can guests book?</h3>
                  <p className="text-[11px] text-gray-400">Select at least one rate plan</p>
                </div>
              </div>
              <div className="ml-9 space-y-2.5">
                {/* Flexible Rate */}
                <div className={`rounded-xl border px-4 py-3.5 transition-colors ${flexibleRateEnabled ? 'border-primary-200 bg-primary-50/30' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setFlexibleRateEnabled(!flexibleRateEnabled)}
                      className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${flexibleRateEnabled ? 'bg-primary-500' : 'bg-gray-300'}`}
                    >
                      <div className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${flexibleRateEnabled ? 'left-[20px]' : 'left-[2px]'}`} />
                    </button>
                    <svg className="w-4 h-4 text-primary-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                    <span className="text-[12px] font-semibold text-gray-900">Flexible rate</span>
                    <span className="text-[11px] text-gray-400">(free cancellation)</span>
                  </div>
                  {flexibleRateEnabled && (
                    <div className="mt-3 ml-[52px]">
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] text-gray-500">Cancellation policy:</span>
                        <select
                          value={cancellationPolicy}
                          onChange={(e) => setCancellationPolicy(e.target.value)}
                          className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 appearance-none"
                          style={{ ...SELECT_ARROW_STYLE, backgroundPosition: 'right 10px center' }}
                        >
                          <option>Free until 1 day before</option>
                          <option>Free until 2 days before</option>
                          <option>Free until 3 days before</option>
                          <option>Free until 5 days before</option>
                          <option>Free until 7 days before</option>
                          <option>Free until 14 days before</option>
                          <option>Free until 30 days before</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                {/* Non-refundable */}
                <div className={`rounded-xl border px-4 py-3.5 transition-colors ${nonRefundableEnabled ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        const next = !nonRefundableEnabled
                        setNonRefundableEnabled(next)
                        if (next) {
                          updateForm({ nonRefundableRate: Math.round((form.baseRate || 0) * (1 - nonRefundableDiscount / 100) * 100) / 100 })
                        } else {
                          updateForm({ nonRefundableRate: null })
                        }
                      }}
                      className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${nonRefundableEnabled ? 'bg-primary-500' : 'bg-gray-300'}`}
                    >
                      <div className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${nonRefundableEnabled ? 'left-[20px]' : 'left-[2px]'}`} />
                    </button>
                    <svg className="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    <span className="text-[12px] font-semibold text-gray-900">Non-refundable</span>
                    <span className="text-[11px] text-gray-400">(discount for no cancellation)</span>
                  </div>
                  {nonRefundableEnabled && flexibleRateEnabled && (
                    <div className="mt-3 ml-[52px] flex items-center gap-3">
                      <span className="text-[11px] text-gray-500">Discount:</span>
                      <div className="inline-flex items-center gap-0 border border-gray-200 rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.max(1, nonRefundableDiscount - 1)
                            setNonRefundableDiscount(next)
                            updateForm({ nonRefundableRate: Math.round((form.baseRate || 0) * (1 - next / 100) * 100) / 100 })
                          }}
                          className="px-2 py-1.5 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
                        >
                          &minus;
                        </button>
                        <div className="relative flex items-center bg-white min-w-[48px]">
                          <input
                            type="number"
                            min={1}
                            max={50}
                            value={nonRefundableDiscount}
                            onChange={(e) => {
                              const val = Math.max(1, Math.min(50, parseInt(e.target.value) || 1))
                              setNonRefundableDiscount(val)
                              updateForm({ nonRefundableRate: Math.round((form.baseRate || 0) * (1 - val / 100) * 100) / 100 })
                            }}
                            className="w-[40px] px-1 py-1.5 text-[12px] font-semibold text-gray-900 text-center bg-transparent outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <span className="text-[12px] font-semibold text-gray-900 pr-1">%</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.min(50, nonRefundableDiscount + 1)
                            setNonRefundableDiscount(next)
                            updateForm({ nonRefundableRate: Math.round((form.baseRate || 0) * (1 - next / 100) * 100) / 100 })
                          }}
                          className="px-2 py-1.5 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
                        >
                          +
                        </button>
                      </div>
                      <span className="text-[11px] text-gray-500">off flexible rate</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Section 4: Weekend surcharge */}
            <div>
              <div className="flex items-start gap-3 mb-2">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">4</span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">Do weekends cost more?</h3>
                  <p className="text-[11px] text-gray-400">Weekend pricing applies to Friday & Saturday nights across all seasons</p>
                </div>
              </div>
              <div className="ml-9 flex flex-wrap items-center gap-2">
                {['+0%', '+10%', '+15%', '+20%'].map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setWeekendSurcharge(opt)}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium border transition-colors ${
                      weekendSurcharge === opt
                        ? 'bg-primary-500 text-white border-primary-500'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
                {!['+0%', '+10%', '+15%', '+20%'].includes(weekendSurcharge) ? (
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] text-gray-500">+</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={weekendSurcharge.replace(/[^0-9]/g, '')}
                      onChange={(e) => setWeekendSurcharge(`+${e.target.value}%`)}
                      className="w-14 px-2 py-1.5 bg-white border border-primary-500 rounded-full text-[11px] text-center font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      autoFocus
                    />
                    <span className="text-[11px] text-gray-500">%</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setWeekendSurcharge('+%')}
                    className="px-4 py-1.5 rounded-full text-[11px] font-medium border transition-colors bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                  >
                    Custom
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Right column: LIVE RATE PREVIEW */}
          <div className="lg:col-span-2">
            <div className="sticky top-4 rounded-xl border border-gray-200 bg-white overflow-hidden">
              {/* Header */}
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[13px]">&#x1F4C5;</span>
                  <span className="text-[11px] font-bold text-gray-700 uppercase tracking-wider">Live Rate Preview</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewMonth(new Date(previewMonth.getFullYear(), previewMonth.getMonth() - 1, 1))}
                    className="p-1 rounded hover:bg-gray-200 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                  </button>
                  <span className="text-[11px] font-semibold text-gray-700 min-w-[80px] text-center">
                    {previewMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPreviewMonth(new Date(previewMonth.getFullYear(), previewMonth.getMonth() + 1, 1))}
                    className="p-1 rounded hover:bg-gray-200 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                  </button>
                </div>
              </div>

              {/* Season legend */}
              {seasons.length > 0 && (
                <div className="px-4 py-2.5 border-b border-gray-100 space-y-1">
                  {seasons.map((s, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-[10px]">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: ({'Low':'#38bdf8','Mid':'#3b82f6','High':'#1d4ed8','Peak':'#4338ca'}[s.tier] || '#9ca3af') }} />
                      <span className="font-medium text-gray-700">{s.name || `Season ${idx + 1}`}</span>
                      {s.from && s.to && <span className="text-gray-400">{s.from} - {s.to}</span>}
                      {s.rate && <span className="text-gray-500 ml-auto">{getCurrencySymbol(form.currency || 'EUR')}{s.rate}/night</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Calendar grid */}
              <div className="px-3 py-3">
                <div className="grid grid-cols-7 gap-0.5 mb-1">
                  {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
                    <div key={d} className={`text-center text-[9px] font-semibold py-1 ${d === 'Fri' || d === 'Sat' ? 'text-orange-500' : 'text-gray-400'}`}>
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-0.5">
                  {(() => {
                    const year = previewMonth.getFullYear()
                    const month = previewMonth.getMonth()
                    const firstDay = new Date(year, month, 1)
                    const lastDay = new Date(year, month + 1, 0)
                    const daysInMonth = lastDay.getDate()
                    // Monday = 0, Sunday = 6
                    let startDow = firstDay.getDay() - 1
                    if (startDow < 0) startDow = 6
                    const surchargeNum = parseInt(weekendSurcharge.replace(/[^0-9]/g, '')) || 0

                    const cells: React.ReactNode[] = []
                    // Empty cells for days before the 1st
                    for (let i = 0; i < startDow; i++) {
                      cells.push(<div key={`empty-${i}`} className="h-10" />)
                    }
                    for (let day = 1; day <= daysInMonth; day++) {
                      const date = new Date(year, month, day)
                      const dow = date.getDay() // 0=Sun, 5=Fri, 6=Sat
                      const isWeekend = dow === 5 || dow === 6
                      const inOp = isInOperatingPeriod(day)
                      const season = getSeasonForDate(day)
                      let rate = season ? (parseFloat(season.rate) || 0) : 0
                      if (isWeekend && rate > 0) {
                        rate = Math.round(rate * (1 + surchargeNum / 100))
                      }

                      const dateStr = date.toISOString().split('T')[0]
                      const hasDailyOverride = dailyRates[dateStr] !== undefined
                      const displayRate = hasDailyOverride ? dailyRates[dateStr] : rate
                      const inGap = inOp && !season && !hasDailyOverride && isInSeasonGap(dateStr)
                      const seasonBgHex: Record<string, string> = { 'Low': '#f0f9ff', 'Mid': '#eff6ff', 'High': '#dbeafe', 'Peak': '#e0e7ff' }
                      const cellBg = !inOp ? '#f9fafb' : hasDailyOverride ? '#fefce8' : inGap ? '#fef2f2' : isWeekend && season ? '#fffbeb' : season ? (seasonBgHex[season.tier] || '#f9fafb') : '#ffffff'
                      const isEditing = editingDay === dateStr
                      const currencySymbol = getCurrencySymbol(form.currency || 'EUR')

                      cells.push(
                        <div
                          key={day}
                          className={`h-10 rounded-md flex flex-col items-center justify-center text-center transition-colors border cursor-pointer ${!inOp ? 'opacity-40 border-gray-100' : hasDailyOverride ? 'border-amber-300 ring-1 ring-amber-200' : inGap ? 'border-red-200' : 'border-gray-100 hover:border-primary-300'}`}
                          style={{ backgroundColor: cellBg }}
                          title={hasDailyOverride ? `Daily override: ${currencySymbol}${dailyRates[dateStr]} (click to edit, right-click to remove)` : inGap ? 'No season — click to set a daily rate' : 'Click to set a daily rate override'}
                          onClick={() => {
                            if (!inOp) return
                            setEditingDay(dateStr)
                            setEditingDayValue(hasDailyOverride ? String(dailyRates[dateStr]) : displayRate > 0 ? String(displayRate) : '')
                          }}
                          onContextMenu={(e) => {
                            if (!hasDailyOverride) return
                            e.preventDefault()
                            const next = { ...dailyRates }
                            delete next[dateStr]
                            setDailyRates(next)
                          }}
                        >
                          {isEditing ? (
                            <input
                              type="number"
                              min={0}
                              autoFocus
                              value={editingDayValue}
                              onChange={(e) => setEditingDayValue(e.target.value)}
                              onBlur={() => {
                                const val = parseFloat(editingDayValue)
                                if (val > 0) {
                                  setDailyRates({ ...dailyRates, [dateStr]: val })
                                } else {
                                  const next = { ...dailyRates }
                                  delete next[dateStr]
                                  setDailyRates(next)
                                }
                                setEditingDay(null)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                if (e.key === 'Escape') { setEditingDay(null) }
                              }}
                              className="w-full h-full text-[9px] text-center bg-white border-0 outline-none focus:ring-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <>
                              <span className={`text-[10px] font-medium ${inGap ? 'text-red-600' : isWeekend ? 'text-orange-600' : 'text-gray-700'}`}>{day}</span>
                              {inOp && displayRate > 0 && (
                                <span className={`text-[8px] font-semibold ${hasDailyOverride ? 'text-amber-600' : isWeekend ? 'text-orange-600' : 'text-emerald-600'}`}>
                                  {currencySymbol}{displayRate}
                                </span>
                              )}
                              {inGap && (
                                <span className="text-[7px] font-semibold text-red-400">no price</span>
                              )}
                            </>
                          )}
                        </div>
                      )
                    }
                    return cells
                  })()}
                </div>
              </div>

              {/* Daily overrides hint */}
              <div className="px-4 py-2 border-t border-gray-100 bg-gray-50/50">
                <p className="text-[9px] text-gray-400">Click a date to set a daily price override. Right-click an override to remove it.</p>
                {Object.keys(dailyRates).length > 0 && (
                  <p className="text-[9px] text-amber-600 font-medium mt-0.5">{Object.keys(dailyRates).length} daily override{Object.keys(dailyRates).length !== 1 ? 's' : ''} set</p>
                )}
              </div>

              {/* Bottom legend */}
              <div className="px-4 py-2.5 border-t border-gray-100 flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#38bdf8' }} /><span className="text-[9px] text-gray-500">Low</span></span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#3b82f6' }} /><span className="text-[9px] text-gray-500">Mid</span></span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#1d4ed8' }} /><span className="text-[9px] text-gray-500">High</span></span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#4338ca' }} /><span className="text-[9px] text-gray-500">Peak</span></span>
                {parseInt(weekendSurcharge.replace(/[^0-9]/g, '')) > 0 && (
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#fbbf24' }} /><span className="text-[9px] text-gray-500">Weekend +</span></span>
                )}
                {Object.keys(dailyRates).length > 0 && (
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#f59e0b' }} /><span className="text-[9px] text-gray-500">Override</span></span>
                )}
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#d1d5db' }} /><span className="text-[9px] text-gray-500">Closed</span></span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Images & Amenities */}
      {activeTab === 'media' && (
        <div className="space-y-4">
          {/* Room Images Section */}
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-6">
            <ImageUpload
              images={form.images || []}
              onChange={(urls) => updateForm({ images: urls })}
              maxImages={10}
              label="Room Images"
            />
          </div>

          {/* Features Section */}
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Features</h3>
                <span className="text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">&rarr; Room card tags</span>
                <span className="text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">&rarr; Modal highlights</span>
              </div>
              <span className="text-[11px] font-medium text-primary-600">{(form.features || []).length} selected</span>
            </div>
            <p className="text-[10px] text-gray-400">What makes this room special — guests see these tags directly on the room listing. Choose the 3–6 most compelling highlights.</p>

            {/* Live Preview */}
            <div className="bg-gray-50 rounded-lg border border-gray-200 px-4 py-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Live Preview — Room Card</p>
              <p className="text-[12px] font-semibold text-gray-900">{form.name || 'Room name'} <span className="text-[11px] font-normal text-gray-400">&middot; Up to {form.maxOccupancy} guests</span></p>
              {(form.features || []).length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(form.features || []).slice(0, 5).map((f) => (
                    <span key={f} className="text-[10px] text-gray-600 border border-gray-200 bg-white rounded-full px-2 py-0.5">{f}</span>
                  ))}
                  {(form.features || []).length > 5 && (
                    <span className="text-[10px] text-gray-400 border border-gray-200 bg-white rounded-full px-2 py-0.5">+{(form.features || []).length - 5} more</span>
                  )}
                </div>
              ) : (
                <p className="text-[10px] text-gray-400 mt-1 italic">Select features below to preview card tags...</p>
              )}
            </div>

            {/* Feature Categories */}
            {FEATURE_CATEGORIES.map((cat) => (
              <div key={cat.name}>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">{cat.name}</p>
                <div className="flex flex-wrap gap-2">
                  {cat.items.map((item) => {
                    const isSelected = (form.features || []).includes(item.label)
                    return (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => {
                          const features = form.features || []
                          if (isSelected) {
                            updateForm({ features: features.filter((f) => f !== item.label) })
                          } else {
                            updateForm({ features: [...features, item.label] })
                          }
                        }}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                          isSelected
                            ? 'border-primary-300 bg-primary-50 text-primary-700'
                            : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <span className="text-[13px]">{item.emoji}</span>
                        {item.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}

            <p className="text-[10px] text-gray-400">{(form.features || []).length} features selected &middot; First 5 shown on card</p>
          </div>

          {/* Amenities Section */}
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Amenities</h3>
                <span className="text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">&rarr; Modal full list</span>
              </div>
              <span className="text-[11px] font-medium text-primary-600">{(form.amenities || []).length} selected</span>
            </div>
            <p className="text-[10px] text-gray-400">What&apos;s included — guests see these after clicking &quot;View Details&quot;. Group by category for easy scanning.</p>

            <div className="space-y-1">
              {AMENITY_CATEGORIES.map((cat) => {
                const amenities = form.amenities || []
                const customInCat = (customAmenitiesByCategory[cat.name] || []).filter(a => amenities.includes(a))
                const selectedCount = cat.items.filter((item) => amenities.includes(item)).length + customInCat.length
                const isExpanded = expandedAmenityCategories.includes(cat.name)
                const allSelected = selectedCount === cat.items.length

                return (
                  <div key={cat.name} className="border border-gray-200 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => {
                        if (isExpanded) {
                          setExpandedAmenityCategories(prev => prev.filter(c => c !== cat.name))
                        } else {
                          setExpandedAmenityCategories(prev => [...prev, cat.name])
                        }
                      }}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <ChevronDownIcon className={`w-3.5 h-3.5 text-gray-400 transition-transform ${isExpanded ? '' : '-rotate-90'}`} />
                        <span className="text-[12px] font-semibold text-gray-900">{cat.name}</span>
                      </div>
                      <span className="text-[11px] text-gray-400">{selectedCount} selected</span>
                    </button>

                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-2">
                        <button
                          type="button"
                          onClick={() => {
                            if (allSelected) {
                              updateForm({ amenities: amenities.filter(a => !cat.items.includes(a)) })
                            } else {
                              updateForm({ amenities: Array.from(new Set([...amenities, ...cat.items])) })
                            }
                          }}
                          className="text-[11px] text-primary-600 font-medium hover:text-primary-700"
                        >
                          {allSelected ? 'Deselect all' : 'Select all'}
                        </button>

                        <div className="space-y-1.5">
                          {cat.items.map((item) => {
                            const isSelected = amenities.includes(item)
                            return (
                              <button
                                key={item}
                                type="button"
                                onClick={() => {
                                  if (isSelected) {
                                    updateForm({ amenities: amenities.filter(a => a !== item) })
                                  } else {
                                    updateForm({ amenities: [...amenities, item] })
                                  }
                                }}
                                className="flex items-center gap-3 w-full text-left"
                              >
                                <div className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${
                                  isSelected ? 'border-primary-500 bg-primary-500' : 'border-gray-300'
                                }`}>
                                  {isSelected && <CheckIcon className="w-2.5 h-2.5 text-white" />}
                                </div>
                                <span className="text-[12px] text-gray-700">{item}</span>
                              </button>
                            )
                          })}
                        </div>

                        {/* Custom amenities in this category */}
                        {(customAmenitiesByCategory[cat.name] || []).filter(a => amenities.includes(a)).length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            {(customAmenitiesByCategory[cat.name] || []).filter(a => amenities.includes(a)).map(a => (
                              <span key={a} className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200">
                                {a}
                                <button type="button" onClick={() => {
                                  updateForm({ amenities: amenities.filter(x => x !== a) })
                                  setCustomAmenitiesByCategory(prev => ({ ...prev, [cat.name]: (prev[cat.name] || []).filter(x => x !== a) }))
                                }} className="text-primary-400 hover:text-primary-600">
                                  <XMarkIcon className="w-3 h-3" />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Custom amenity input */}
                        <div className="flex gap-2 mt-2">
                          <input
                            type="text"
                            value={customAmenityInputs[cat.name] || ''}
                            onChange={(e) => setCustomAmenityInputs(prev => ({ ...prev, [cat.name]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                const trimmed = (customAmenityInputs[cat.name] || '').trim()
                                if (trimmed && !amenities.some(a => a.toLowerCase() === trimmed.toLowerCase())) {
                                  updateForm({ amenities: [...amenities, trimmed] })
                                  setCustomAmenitiesByCategory(prev => ({ ...prev, [cat.name]: [...(prev[cat.name] || []), trimmed] }))
                                  setCustomAmenityInputs(prev => ({ ...prev, [cat.name]: '' }))
                                }
                              }
                            }}
                            className="flex-1 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                            placeholder="+ Add custom amenity..."
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const trimmed = (customAmenityInputs[cat.name] || '').trim()
                              if (trimmed && !amenities.some(a => a.toLowerCase() === trimmed.toLowerCase())) {
                                updateForm({ amenities: [...amenities, trimmed] })
                                setCustomAmenitiesByCategory(prev => ({ ...prev, [cat.name]: [...(prev[cat.name] || []), trimmed] }))
                                setCustomAmenityInputs(prev => ({ ...prev, [cat.name]: '' }))
                              }
                            }}
                            className="px-2 py-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                          >
                            <PlusIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Custom amenities not assigned to any category */}
            {(() => {
              const allPredefined = AMENITY_CATEGORIES.flatMap(c => c.items)
              const allCustomTracked = Object.values(customAmenitiesByCategory).flat()
              const untracked = (form.amenities || []).filter(a => !allPredefined.includes(a) && !allCustomTracked.includes(a))
              if (untracked.length === 0) return null
              return (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {untracked.map(a => (
                    <span key={a} className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200">
                      {a}
                      <button type="button" onClick={() => updateForm({ amenities: (form.amenities || []).filter(x => x !== a) })} className="text-primary-400 hover:text-primary-600">
                        <XMarkIcon className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )
            })()}

            <p className="text-[10px] text-gray-400">{(form.amenities || []).length} amenities selected &middot; Shown as &quot;View Full Amenities ({(form.amenities || []).length})&quot; in the room detail modal</p>
          </div>
        </div>
      )}

      {/* Submit / Cancel */}
      <div className="mt-6 flex items-center justify-end gap-3">
        <Link
          href={cancelHref}
          className="px-4 py-2 text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={saving || overlappingSeasonIndices.size > 0 || seasonGaps.length > 0 || operatingPeriods.some(p => p.from && p.to && p.to < p.from)}
          className="px-6 py-2 bg-primary-600 text-white text-[12px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  )
}
