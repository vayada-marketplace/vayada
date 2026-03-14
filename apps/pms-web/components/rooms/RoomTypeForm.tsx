'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { XMarkIcon, PlusIcon, CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { RoomTypeCreate, RoomTypeUpdate } from '@/services/rooms'
import ImageUpload from '@/components/ImageUpload'

const BED_TYPES = ['King Bed', 'Queen Bed', 'Double Bed', 'Twin Beds', 'Single Bed', 'Bunk Bed', 'Sofa Bed']

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

const BENEFIT_OPTIONS = [
  'Welcome Drink on Arrival',
  '10% Spa Discount',
  'Late Check-out (subject to availability)',
  'Early Check-in (subject to availability)',
  'Free Airport Transfer',
  'Daily Breakfast Included',
  'Room Upgrade (subject to availability)',
]

type RoomTab = 'details' | 'pricing' | 'media' | 'benefits'
const ROOM_TABS: { key: RoomTab; label: string }[] = [
  { key: 'details', label: 'Room Details' },
  { key: 'pricing', label: 'Pricing & Rates' },
  { key: 'media', label: 'Images & Amenities' },
  { key: 'benefits', label: 'Book Direct Benefits' },
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
  const [benefitInput, setBenefitInput] = useState('')

  // Local-only fields not in PMS RoomTypeCreate/Update
  const [beds, setBeds] = useState<{ type: string; count: number }[]>(() => parseBedType(form.bedType || ''))
  const [operatingPeriods, setOperatingPeriods] = useState<{ from: string; to: string }[]>([{ from: '2026-01-01', to: '2026-12-31' }])
  const [seasons, setSeasons] = useState<{ name: string; from: string; to: string; rate: string }[]>([])
  const [weekendSurcharge, setWeekendSurcharge] = useState('+0%')
  const [cancellationPolicy, setCancellationPolicy] = useState('Free until 7 days before')
  const [flexibleRateEnabled, setFlexibleRateEnabled] = useState(true)
  const [nonRefundableEnabled, setNonRefundableEnabled] = useState((form.nonRefundableRate ?? null) !== null)
  const [nonRefundableDiscount, setNonRefundableDiscount] = useState(10)
  const benefits: string[] = form.benefits || []
  const [category, setCategory] = useState('')
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

  const updateForm = (updates: Partial<RoomTypeCreate>) => {
    onChange({ ...form, ...updates })
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
          <div className="grid grid-cols-4 gap-4 items-end">
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
                <label className="text-[12px] font-semibold text-gray-900">Room Size (m&sup2;)</label>
              </div>
              <input
                type="number"
                min={0}
                value={form.size ?? 0}
                onChange={(e) => updateForm({ size: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                placeholder="150"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Total Rooms <span className="text-red-500">*</span></label>
              </div>
              <input
                type="number"
                min={1}
                value={form.totalRooms ?? 1}
                onChange={(e) => updateForm({ totalRooms: Math.max(1, Number(e.target.value)) })}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
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
              <span className="text-[10px] text-gray-400">(shows in PMS room list)</span>
            </div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
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
        <div className="space-y-8">
          {/* Section 1: What can guests book? */}
          <div>
            <div className="flex items-start gap-3 mb-1">
              <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">1</span>
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
                          const next = Math.max(1, nonRefundableDiscount - 5)
                          setNonRefundableDiscount(next)
                          updateForm({ nonRefundableRate: Math.round((form.baseRate || 0) * (1 - next / 100) * 100) / 100 })
                        }}
                        className="px-2 py-1.5 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
                      >
                        &minus;
                      </button>
                      <span className="px-3 py-1.5 text-[12px] font-semibold text-gray-900 bg-white min-w-[48px] text-center">
                        {nonRefundableDiscount}%
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const next = Math.min(50, nonRefundableDiscount + 5)
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

          {/* Section 2: When are you open? */}
          <div>
            <div className="flex items-start gap-3 mb-1">
              <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">2</span>
              <div>
                <h3 className="text-[13px] font-semibold text-gray-900">When are you open?</h3>
                <p className="text-[11px] text-gray-400">Everything outside these dates is automatically closed</p>
              </div>
            </div>
            <div className="ml-9">
              <div className="rounded-xl border border-gray-200 bg-gray-50/50 px-5 py-4 space-y-3">
                {operatingPeriods.map((period, idx) => (
                  <div key={idx} className="flex items-center gap-3">
                    <input
                      type="date"
                      value={period.from}
                      onChange={(e) => {
                        const updated = [...operatingPeriods]
                        updated[idx] = { ...updated[idx], from: e.target.value }
                        setOperatingPeriods(updated)
                      }}
                      className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                    <span className="text-[11px] text-gray-400">to</span>
                    <input
                      type="date"
                      value={period.to}
                      onChange={(e) => {
                        const updated = [...operatingPeriods]
                        updated[idx] = { ...updated[idx], to: e.target.value }
                        setOperatingPeriods(updated)
                      }}
                      className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
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
                ))}
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

          {/* Section 3: Seasonal pricing */}
          <div>
            <div className="flex items-start gap-3 mb-1">
              <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">3</span>
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
                  {seasons.map((season, idx) => (
                    <div key={idx} className="rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 flex items-center gap-3">
                      <input
                        type="text"
                        value={season.name}
                        onChange={(e) => { const u = [...seasons]; u[idx] = { ...u[idx], name: e.target.value }; setSeasons(u) }}
                        className="w-28 px-2 py-1 bg-white border border-gray-200 rounded text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      <input type="date" value={season.from} onChange={(e) => { const u = [...seasons]; u[idx] = { ...u[idx], from: e.target.value, ...(u[idx].to && e.target.value > u[idx].to ? { to: '' } : {}) }; setSeasons(u) }} className="px-2 py-1 bg-white border border-gray-200 rounded text-[10px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500" />
                      <span className="text-[10px] text-gray-400">to</span>
                      <input type="date" value={season.to} min={season.from || undefined} onChange={(e) => { const u = [...seasons]; u[idx] = { ...u[idx], to: e.target.value }; setSeasons(u) }} className="px-2 py-1 bg-white border border-gray-200 rounded text-[10px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500" />
                      <input
                        type="number"
                        placeholder="Rate"
                        value={season.rate}
                        onChange={(e) => { const u = [...seasons]; u[idx] = { ...u[idx], rate: e.target.value }; setSeasons(u) }}
                        className="w-20 px-2 py-1 bg-white border border-gray-200 rounded text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      <button type="button" onClick={() => setSeasons(seasons.filter((_, i) => i !== idx))} className="text-gray-400 hover:text-red-500 transition-colors">
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setSeasons([...seasons, { name: '', from: '', to: '', rate: '' }])}
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-600 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <PlusIcon className="w-3.5 h-3.5" /> Add season
              </button>
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
                const selectedCount = cat.items.filter((item) => amenities.includes(item)).length
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
                              updateForm({ amenities: [...new Set([...amenities, ...cat.items])] })
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
                                if (trimmed && !amenities.includes(trimmed)) {
                                  updateForm({ amenities: [...amenities, trimmed] })
                                }
                                setCustomAmenityInputs(prev => ({ ...prev, [cat.name]: '' }))
                              }
                            }}
                            className="flex-1 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                            placeholder="+ Add custom amenity..."
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const trimmed = (customAmenityInputs[cat.name] || '').trim()
                              if (trimmed && !amenities.includes(trimmed)) {
                                updateForm({ amenities: [...amenities, trimmed] })
                              }
                              setCustomAmenityInputs(prev => ({ ...prev, [cat.name]: '' }))
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

            <p className="text-[10px] text-gray-400">{(form.amenities || []).length} amenities selected &middot; Shown as &quot;View Full Amenities ({(form.amenities || []).length})&quot; in the room detail modal</p>
          </div>
        </div>
      )}

      {/* Tab 4: Book Direct Benefits */}
      {activeTab === 'benefits' && (
        <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Book Direct Benefits</h3>
            <span className="text-[11px] font-medium text-gray-400">Optional</span>
          </div>

          <p className="text-[11px] text-gray-500">These appear in the room detail modal under a &quot;Book Direct Benefits&quot; section, encouraging guests to book via your website instead of OTAs.</p>

          {/* Predefined benefit options */}
          <div className="space-y-2">
            {BENEFIT_OPTIONS.map((benefit) => {
              const isSelected = benefits.includes(benefit)
              return (
                <button
                  key={benefit}
                  type="button"
                  onClick={() => {
                    if (isSelected) {
                      updateForm({ benefits: benefits.filter((b) => b !== benefit) })
                    } else {
                      updateForm({ benefits: [...benefits, benefit] })
                    }
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-2 rounded-lg border text-left transition-colors ${
                    isSelected
                      ? 'border-primary-300 bg-primary-50/30'
                      : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                  }`}
                >
                  <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                    isSelected ? 'border-primary-500 bg-primary-500' : 'border-gray-300'
                  }`}>
                    {isSelected && (
                      <CheckIcon className="w-2 h-2 text-white" />
                    )}
                  </div>
                  <span className="text-[12px] text-gray-700">{benefit}</span>
                </button>
              )
            })}
          </div>

          {/* Custom benefit input */}
          <div>
            <label className="block text-[11px] text-gray-500 mb-1.5">Custom Benefit <span className="text-gray-400">(optional)</span></label>
            <div className="flex gap-2">
              <input
                type="text"
                value={benefitInput}
                onChange={(e) => setBenefitInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const trimmed = benefitInput.trim()
                    if (trimmed && !benefits.includes(trimmed)) {
                      updateForm({ benefits: [...benefits, trimmed] })
                    }
                    setBenefitInput('')
                  }
                }}
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                placeholder="e.g. Complimentary sunset cocktail"
              />
              <button
                type="button"
                onClick={() => {
                  const trimmed = benefitInput.trim()
                  if (trimmed && !benefits.includes(trimmed)) {
                    updateForm({ benefits: [...benefits, trimmed] })
                  }
                  setBenefitInput('')
                }}
                className="px-3 py-2 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <PlusIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Selected custom benefits */}
          {benefits.filter(b => !BENEFIT_OPTIONS.includes(b)).length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider">Custom benefits</span>
              <div className="flex flex-wrap gap-2">
                {benefits.filter(b => !BENEFIT_OPTIONS.includes(b)).map((b, i) => (
                  <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200">
                    {b}
                    <button type="button" onClick={() => updateForm({ benefits: benefits.filter(x => x !== b) })} className="text-primary-400 hover:text-primary-600">
                      <XMarkIcon className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
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
          disabled={saving}
          className="px-6 py-2 bg-primary-600 text-white text-[12px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  )
}
