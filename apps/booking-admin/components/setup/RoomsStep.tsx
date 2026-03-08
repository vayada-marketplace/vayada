'use client'

import { RefObject } from 'react'
import { XMarkIcon, PlusIcon, CheckIcon } from '@heroicons/react/24/outline'

export interface RoomType {
  name: string
  beds: { type: string; count: number }[]
  maxOccupancy: number
  bedrooms: number
  bathrooms: number
  roomSize: string
  totalRooms: number
  description: string
  category: string
  baseRate: string
  nonRefundableRate: string
  nonRefundableDiscount: number
  flexibleRateEnabled: boolean
  nonRefundableEnabled: boolean
  cancellationPolicy: string
  operatingFrom: string
  operatingTo: string
  seasons: { name: string; from: string; to: string; rate: string }[]
  weekendSurcharge: string
  currency: string
  images: string[]
  amenities: string[]
  features: string[]
  bookDirectBenefits: string[]
}

export const createEmptyRoom = (): RoomType => ({
  name: '',
  beds: [{ type: 'King Bed', count: 1 }],
  maxOccupancy: 2,
  bedrooms: 1,
  bathrooms: 1,
  roomSize: '',
  totalRooms: 1,
  description: '',
  category: '',
  baseRate: '',
  nonRefundableRate: '',
  nonRefundableDiscount: 10,
  flexibleRateEnabled: true,
  nonRefundableEnabled: false,
  cancellationPolicy: 'Free until 7 days before',
  operatingFrom: '2026-01-01',
  operatingTo: '2026-12-31',
  seasons: [],
  weekendSurcharge: '+0%',
  currency: '',
  images: [],
  amenities: [],
  features: [],
  bookDirectBenefits: [],
})

export const getRoomCompleteness = (room: RoomType): { done: number; total: number } => {
  let done = 0
  const total = 4
  if (room.name.trim() && room.maxOccupancy >= 1 && room.totalRooms >= 1) done++
  if (room.flexibleRateEnabled || room.nonRefundableEnabled) done++
  if (room.images.length > 0) done++
  if (room.bookDirectBenefits.length > 0) done++
  return { done, total }
}

export const BED_TYPES = ['King Bed', 'Queen Bed', 'Double Bed', 'Twin Beds', 'Single Bed', 'Bunk Bed', 'Sofa Bed']

export const ROOM_CATEGORIES = ['Standard', 'Deluxe', 'Superior', 'Suite', 'Villa', 'Bungalow', 'Studio', 'Penthouse']

export const QUICK_AMENITIES = [
  { label: 'Private Pool', emoji: '\uD83C\uDFCA' },
  { label: 'Entire villa', emoji: '\uD83C\uDFE1' },
  { label: 'Free WiFi', emoji: '\uD83D\uDCF6' },
  { label: 'Air conditioning', emoji: '\u2744\uFE0F' },
  { label: 'Pool view', emoji: '\uD83C\uDFCA' },
  { label: 'Ocean view', emoji: '\uD83C\uDFD6\uFE0F' },
  { label: 'Mountain view', emoji: '\u26F0\uFE0F' },
  { label: 'Kitchen', emoji: '\uD83C\uDF73' },
  { label: 'Flat-screen TV', emoji: '\uD83D\uDCFA' },
  { label: 'Garden', emoji: '\uD83C\uDF3F' },
  { label: 'Spa bath', emoji: '\uD83D\uDEC1' },
  { label: 'Parking', emoji: '\uD83C\uDD7F\uFE0F' },
]

export const BENEFIT_OPTIONS = [
  'Welcome Drink on Arrival',
  '10% Spa Discount',
  'Late Check-out (subject to availability)',
  'Early Check-in (subject to availability)',
  'Free Airport Transfer',
  'Daily Breakfast Included',
  'Room Upgrade (subject to availability)',
]

type RoomTab = 'details' | 'pricing' | 'media' | 'benefits'
export const ROOM_TABS: { key: RoomTab; label: string }[] = [
  { key: 'details', label: 'Room Details' },
  { key: 'pricing', label: 'Pricing & Rates' },
  { key: 'media', label: 'Images, Features & Amenities' },
  { key: 'benefits', label: 'Book Direct Benefits' },
]

interface RoomsStepProps {
  rooms: RoomType[]
  setRooms: (v: RoomType[] | ((prev: RoomType[]) => RoomType[])) => void
  activeRoomIndex: number
  setActiveRoomIndex: (v: number) => void
  activeRoomTab: RoomTab
  setActiveRoomTab: (v: RoomTab) => void
  amenityInput: string; setAmenityInput: (v: string) => void
  featureInput: string; setFeatureInput: (v: string) => void
  benefitInput: string; setBenefitInput: (v: string) => void
  roomFileInputRef: RefObject<HTMLInputElement>
  uploadingRoomImages: boolean
  handleRoomImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  currency: string
  error: string
  canProceed: boolean
  onBack: () => void
  onContinue: () => void
  stepIndicators: React.ReactNode
}

export default function RoomsStep({
  rooms,
  setRooms,
  activeRoomIndex,
  setActiveRoomIndex,
  activeRoomTab,
  setActiveRoomTab,
  benefitInput, setBenefitInput,
  roomFileInputRef,
  uploadingRoomImages,
  handleRoomImageUpload,
  currency,
  error,
  canProceed,
  onBack,
  onContinue,
  stepIndicators,
}: RoomsStepProps) {
  const room = rooms[activeRoomIndex]
  const updateRoom = (updates: Partial<RoomType>) => {
    setRooms((prev: RoomType[]) => prev.map((r: RoomType, i: number) => i === activeRoomIndex ? { ...r, ...updates } : r))
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto px-6 py-6">
        {stepIndicators}
        <div className="mb-5">
          <h2 className="text-[18px] font-bold text-gray-900">Rooms & Rates</h2>
          <p className="text-[12px] text-gray-500 mt-1">Configure your room types. Each room maps directly to a card guests see on the booking page.</p>
        </div>

        <div className="flex gap-6">
        {/* Room Sidebar */}
        <div className="w-48 shrink-0">
          <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest mb-3">Your Rooms</h3>
          <div className="space-y-2 mb-3">
            {rooms.map((r, idx) => {
              const { done, total } = getRoomCompleteness(r)
              return (
                <div
                  key={idx}
                  onClick={() => { setActiveRoomIndex(idx); setActiveRoomTab('details') }}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors cursor-pointer group ${
                    activeRoomIndex === idx
                      ? 'border-primary-500 bg-primary-50/30'
                      : 'border-gray-200 bg-white hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[14px]">{'\uD83C\uDFE8'}</span>
                    <span className="text-[12px] font-medium text-gray-900 truncate flex-1">
                      {r.name || `Room ${idx + 1}`}
                    </span>
                    {rooms.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const newRooms = rooms.filter((_, i) => i !== idx)
                          setRooms(newRooms)
                          if (activeRoomIndex >= newRooms.length) setActiveRoomIndex(newRooms.length - 1)
                          else if (activeRoomIndex > idx) setActiveRoomIndex(activeRoomIndex - 1)
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-all"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-1.5 ml-6">
                    {Array.from({ length: total }).map((_, di) => (
                      <div
                        key={di}
                        className={`w-1.5 h-1.5 rounded-full ${di < done ? 'bg-primary-500' : 'bg-gray-300'}`}
                      />
                    ))}
                    <span className="text-[10px] text-gray-400 ml-1">{done}/{total}</span>
                  </div>
                </div>
              )
            })}
          </div>
          <button
            onClick={() => {
              const newRoom = createEmptyRoom()
              newRoom.currency = currency
              setRooms((prev: RoomType[]) => [...prev, newRoom])
              setActiveRoomIndex(rooms.length)
              setActiveRoomTab('details')
            }}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-dashed border-gray-300 rounded-lg text-[12px] text-gray-500 font-medium hover:border-gray-400 hover:bg-gray-50 transition-colors"
          >
            <PlusIcon className="w-3.5 h-3.5" /> Add Room Type
          </button>
        </div>

        {/* Room Content */}
        <div className="flex-1 min-w-0">
        {/* Room Tabs */}
        <div className="flex gap-6 mb-6 border-b border-gray-200">
          {ROOM_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveRoomTab(tab.key)}
              className={`pb-2.5 text-[12px] font-medium transition-colors relative ${
                activeRoomTab === tab.key
                  ? 'text-gray-900'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              {tab.label}
              {activeRoomTab === tab.key && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gray-900 rounded-full" />
              )}
            </button>
          ))}
        </div>

        {/* Room Details Tab */}
        {activeRoomTab === 'details' && (
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Room Type Basics</h3>
              <span className="text-[11px] font-medium text-red-500">Required</span>
            </div>

            <div className="flex items-start gap-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg">
              <span className="text-blue-500 mt-0.5">&rarr;</span>
              <p className="text-[11px] text-blue-700">Booking engine: Room card title &middot; &quot;View Details&quot; modal header &middot; Booking summary &middot; PMS Rooms &amp; Rates list</p>
            </div>

            {/* Room Type Name */}
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">
                  Room Type Name <span className="text-red-500">*</span>
                </label>
                <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-100 px-1.5 py-0.5 rounded">Card Title</span>
              </div>
              <input
                type="text"
                value={room.name}
                onChange={(e) => updateRoom({ name: e.target.value })}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                placeholder="e.g. Two-Bedroom Villa"
              />
              <p className="text-[10px] text-gray-400 mt-1">Shown as the bold heading on the room card and in the booking summary</p>
            </div>

            {/* Beds */}
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <label className="text-[12px] font-semibold text-gray-900">Beds</label>
                <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-100 px-1.5 py-0.5 rounded">Modal</span>
              </div>
              <p className="text-[10px] text-gray-400 mb-2">Add all bed types available in this room</p>
              <div className="space-y-2">
                {room.beds.map((bed, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={bed.type}
                      onChange={(e) => {
                        const updated = [...room.beds]
                        updated[idx] = { ...updated[idx], type: e.target.value }
                        updateRoom({ beds: updated })
                      }}
                      className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
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
                        const updated = [...room.beds]
                        updated[idx] = { ...updated[idx], count: Math.max(1, Number(e.target.value)) }
                        updateRoom({ beds: updated })
                      }}
                      className="w-16 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                    />
                    {room.beds.length > 1 && (
                      <button
                        onClick={() => updateRoom({ beds: room.beds.filter((_, i) => i !== idx) })}
                        className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                onClick={() => updateRoom({ beds: [...room.beds, { type: 'King Bed', count: 1 }] })}
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
                <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-100 px-1.5 py-0.5 rounded">Card</span>
              </div>
              <input
                type="number"
                min={1}
                value={room.maxOccupancy}
                onChange={(e) => updateRoom({ maxOccupancy: Math.max(1, Number(e.target.value)) })}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
              <p className="text-[10px] text-gray-400 mt-1">Shows as &quot;Up to X guests&quot; on room card</p>
            </div>

            {/* Bedrooms, Bathrooms, Room Size, Total Rooms */}
            <div className="grid grid-cols-4 gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">Bedrooms</label>
                  <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-100 px-1.5 py-0.5 rounded">Card</span>
                </div>
                <input
                  type="number"
                  min={0}
                  value={room.bedrooms}
                  onChange={(e) => updateRoom({ bedrooms: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">Bathrooms</label>
                  <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-100 px-1.5 py-0.5 rounded">Card</span>
                </div>
                <input
                  type="number"
                  min={0}
                  value={room.bathrooms}
                  onChange={(e) => updateRoom({ bathrooms: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">Room Size (m&sup2;)</label>
                  <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-100 px-1.5 py-0.5 rounded">Card</span>
                </div>
                <input
                  type="number"
                  min={0}
                  value={room.roomSize}
                  onChange={(e) => updateRoom({ roomSize: e.target.value })}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                  placeholder="150"
                />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">Total Rooms <span className="text-red-500">*</span></label>
                  <span className="text-[9px] font-medium text-blue-500 uppercase tracking-wider bg-blue-50 px-1.5 py-0.5 rounded">PMS</span>
                </div>
                <input
                  type="number"
                  min={1}
                  value={room.totalRooms}
                  onChange={(e) => updateRoom({ totalRooms: Math.max(1, Number(e.target.value)) })}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                />
              </div>
            </div>

            {/* Room Description */}
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Room Description</label>
                <span className="text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-100 px-1.5 py-0.5 rounded">Modal</span>
              </div>
              <textarea
                value={room.description}
                onChange={(e) => updateRoom({ description: e.target.value })}
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
                value={room.category}
                onChange={(e) => updateRoom({ category: e.target.value })}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
              >
                <option value="">Select category</option>
                {ROOM_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Pricing & Rates Tab */}
        {activeRoomTab === 'pricing' && (
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
                <div className={`rounded-xl border px-4 py-3.5 transition-colors ${room.flexibleRateEnabled ? 'border-primary-200 bg-primary-50/30' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => updateRoom({ flexibleRateEnabled: !room.flexibleRateEnabled })}
                      className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${room.flexibleRateEnabled ? 'bg-primary-500' : 'bg-gray-300'}`}
                    >
                      <div className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${room.flexibleRateEnabled ? 'left-[20px]' : 'left-[2px]'}`} />
                    </button>
                    <svg className="w-4 h-4 text-primary-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                    <span className="text-[12px] font-semibold text-gray-900">Flexible rate</span>
                    <span className="text-[11px] text-gray-400">(free cancellation)</span>
                  </div>
                  {room.flexibleRateEnabled && (
                    <div className="mt-3 ml-[52px] flex items-center gap-3">
                      <span className="text-[11px] text-gray-500">Cancellation policy:</span>
                      <select
                        value={room.cancellationPolicy}
                        onChange={(e) => updateRoom({ cancellationPolicy: e.target.value })}
                        className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 appearance-none"
                        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
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
                  )}
                </div>

                {/* Non-refundable */}
                <div className={`rounded-xl border px-4 py-3.5 transition-colors ${room.nonRefundableEnabled ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => updateRoom({ nonRefundableEnabled: !room.nonRefundableEnabled })}
                      className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${room.nonRefundableEnabled ? 'bg-primary-500' : 'bg-gray-300'}`}
                    >
                      <div className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${room.nonRefundableEnabled ? 'left-[20px]' : 'left-[2px]'}`} />
                    </button>
                    <svg className="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    <span className="text-[12px] font-semibold text-gray-900">Non-refundable</span>
                    <span className="text-[11px] text-gray-400">(discount for no cancellation)</span>
                  </div>
                  {room.nonRefundableEnabled && room.flexibleRateEnabled && (
                    <div className="mt-3 ml-[52px] flex items-center gap-3">
                      <span className="text-[11px] text-gray-500">Discount:</span>
                      <div className="inline-flex items-center gap-0 border border-gray-200 rounded-lg overflow-hidden">
                        <button
                          onClick={() => updateRoom({ nonRefundableDiscount: Math.max(1, room.nonRefundableDiscount - 5) })}
                          className="px-2 py-1.5 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
                        >
                          &minus;
                        </button>
                        <span className="px-3 py-1.5 text-[12px] font-semibold text-gray-900 bg-white min-w-[48px] text-center">
                          {room.nonRefundableDiscount}%
                        </span>
                        <button
                          onClick={() => updateRoom({ nonRefundableDiscount: Math.min(50, room.nonRefundableDiscount + 5) })}
                          className="px-2 py-1.5 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
                        >
                          +
                        </button>
                      </div>
                      <span className="text-[11px] text-gray-500">off flexible rate</span>
                    </div>
                  )}
                  {room.nonRefundableEnabled && !room.flexibleRateEnabled && (
                    <p className="mt-3 ml-[52px] text-[11px] text-gray-500">
                      Set your base rate in the seasons table below &mdash; this will be used as the non-refundable price.
                    </p>
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
                  <div>
                    <div className="flex justify-between mb-1">
                      {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m) => (
                        <span key={m} className="text-[9px] text-gray-400 w-[calc(100%/12)] text-center">{m}</span>
                      ))}
                    </div>
                    <div className="h-5 rounded-full bg-gradient-to-r from-primary-400 to-primary-500 relative">
                      <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-white">Year Round</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="date"
                      value={room.operatingFrom}
                      onChange={(e) => updateRoom({ operatingFrom: e.target.value })}
                      className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                    <span className="text-[11px] text-gray-400">to</span>
                    <input
                      type="date"
                      value={room.operatingTo}
                      onChange={(e) => updateRoom({ operatingTo: e.target.value })}
                      className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                  </div>
                  <button className="inline-flex items-center gap-1.5 text-[11px] text-gray-600 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors">
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
                {room.seasons.length === 0 ? (
                  <div className="rounded-xl border border-gray-200 bg-gray-50/50 px-5 py-6 text-center">
                    <p className="text-[11px] text-gray-400">No seasons yet. Add one below.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {room.seasons.map((season, idx) => (
                      <div key={idx} className="rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 flex items-center gap-3">
                        <input
                          type="text"
                          value={season.name}
                          onChange={(e) => { const u = [...room.seasons]; u[idx] = { ...u[idx], name: e.target.value }; updateRoom({ seasons: u }) }}
                          className="w-28 px-2 py-1 bg-white border border-gray-200 rounded text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                        <input type="date" value={season.from} onChange={(e) => { const u = [...room.seasons]; u[idx] = { ...u[idx], from: e.target.value }; updateRoom({ seasons: u }) }} className="px-2 py-1 bg-white border border-gray-200 rounded text-[10px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500" />
                        <span className="text-[10px] text-gray-400">to</span>
                        <input type="date" value={season.to} onChange={(e) => { const u = [...room.seasons]; u[idx] = { ...u[idx], to: e.target.value }; updateRoom({ seasons: u }) }} className="px-2 py-1 bg-white border border-gray-200 rounded text-[10px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500" />
                        <input
                          type="number"
                          placeholder="Rate"
                          value={season.rate}
                          onChange={(e) => { const u = [...room.seasons]; u[idx] = { ...u[idx], rate: e.target.value }; updateRoom({ seasons: u }) }}
                          className="w-20 px-2 py-1 bg-white border border-gray-200 rounded text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                        <button onClick={() => updateRoom({ seasons: room.seasons.filter((_, i) => i !== idx) })} className="text-gray-400 hover:text-red-500 transition-colors">
                          <XMarkIcon className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => updateRoom({ seasons: [...room.seasons, { name: '', from: '', to: '', rate: '' }] })}
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
              <div className="ml-9 flex flex-wrap gap-2">
                {['+0%', '+10%', '+15%', '+20%', 'Custom'].map((opt) => (
                  <button
                    key={opt}
                    onClick={() => updateRoom({ weekendSurcharge: opt })}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium border transition-colors ${
                      room.weekendSurcharge === opt
                        ? 'bg-primary-500 text-white border-primary-500'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>

          </div>
        )}

        {/* Images & Amenities Tab */}
        {activeRoomTab === 'media' && (
          <div className="space-y-4">
            {/* Room Images Section */}
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Room Images</h3>
                <span className="text-[11px] font-medium text-amber-600">Strongly recommended</span>
              </div>

              {room.images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {room.images.map((url, idx) => (
                    <div key={idx} className="relative w-24 h-24 rounded-lg overflow-hidden border border-gray-200">
                      <img src={url} alt={`Room ${idx + 1}`} className="w-full h-full object-cover" />
                      <button
                        onClick={() => updateRoom({ images: room.images.filter((_, i) => i !== idx) })}
                        className="absolute top-1 right-1 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center"
                      >
                        <XMarkIcon className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => roomFileInputRef.current?.click()}
                disabled={uploadingRoomImages}
                className="w-full border-2 border-dashed border-gray-300 rounded-xl py-8 flex flex-col items-center justify-center gap-2 text-gray-400 hover:border-gray-400 hover:bg-gray-50/50 transition-colors"
              >
                {uploadingRoomImages ? (
                  <div className="w-8 h-8 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <svg className="w-10 h-10 text-gray-300" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="6" y="6" width="36" height="36" rx="4" />
                      <path d="M6 34l10-10 8 8 6-6 12 12" />
                      <circle cx="18" cy="18" r="3" />
                      <path d="M34 6v8h8" strokeLinecap="round" />
                    </svg>
                    <span className="text-[12px] font-semibold text-gray-700">Upload room photos — drag to reorder</span>
                    <span className="text-[11px] text-gray-400 italic">First image = card cover photo · All images appear in modal gallery</span>
                  </>
                )}
              </button>
              <input
                ref={roomFileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleRoomImageUpload}
                className="hidden"
              />

              <p className="text-[10px] text-gray-400">Shown in: room listing card (left side) · &quot;View Details&quot; modal with prev/next navigation · thumbnail strip at bottom of modal</p>
            </div>

            {/* Amenities & Features Section */}
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Amenities & Features</h3>
                <span className="text-[11px] font-medium text-gray-400">Optional</span>
              </div>

              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[12px] font-semibold text-gray-900">Quick-add amenities</span>
                </div>
                <p className="text-[10px] text-gray-400 mb-3">First 4–5 shown on room card; all shown in &quot;View Full Amenities&quot; in modal</p>

                <div className="flex flex-wrap gap-2">
                  {QUICK_AMENITIES.map((item) => {
                    const isSelected = room.amenities.includes(item.label)
                    return (
                      <button
                        key={item.label}
                        onClick={() => {
                          if (isSelected) {
                            updateRoom({ amenities: room.amenities.filter((a) => a !== item.label) })
                          } else {
                            updateRoom({ amenities: [...room.amenities, item.label] })
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
            </div>
          </div>
        )}

        {/* Book Direct Benefits Tab */}
        {activeRoomTab === 'benefits' && (
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">Book Direct Benefits</h3>
              <span className="text-[11px] font-medium text-gray-400">Optional</span>
            </div>

            <p className="text-[11px] text-gray-500">These appear in the room detail modal under a &quot;Book Direct Benefits&quot; section, encouraging guests to book via your website instead of OTAs.</p>

            {/* Predefined benefit options */}
            <div className="space-y-2">
              {BENEFIT_OPTIONS.map((benefit) => {
                const isSelected = room.bookDirectBenefits.includes(benefit)
                return (
                  <button
                    key={benefit}
                    onClick={() => {
                      if (isSelected) {
                        updateRoom({ bookDirectBenefits: room.bookDirectBenefits.filter((b) => b !== benefit) })
                      } else {
                        updateRoom({ bookDirectBenefits: [...room.bookDirectBenefits, benefit] })
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
                      if (trimmed && !room.bookDirectBenefits.includes(trimmed)) {
                        updateRoom({ bookDirectBenefits: [...room.bookDirectBenefits, trimmed] })
                      }
                      setBenefitInput('')
                    }
                  }}
                  className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                  placeholder="e.g. Complimentary sunset cocktail"
                />
                <button
                  onClick={() => {
                    const trimmed = benefitInput.trim()
                    if (trimmed && !room.bookDirectBenefits.includes(trimmed)) {
                      updateRoom({ bookDirectBenefits: [...room.bookDirectBenefits, trimmed] })
                    }
                    setBenefitInput('')
                  }}
                  className="px-3 py-2 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  <PlusIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-[11px] text-red-700 font-medium">{error}</p>
          </div>
        )}

        </div>{/* close Room Content */}
        </div>{/* close flex sidebar+content */}

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={onBack}
            className="px-4 py-2 text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Back
          </button>
          <div className="flex items-center gap-3">
            {(() => {
              const incomplete = rooms.filter(r => !(r.name.trim() && r.maxOccupancy >= 1 && r.totalRooms >= 1)).length
              return incomplete > 0 ? (
                <span className="text-[11px] text-amber-600 font-medium">{incomplete} room{incomplete > 1 ? 's' : ''} incomplete</span>
              ) : null
            })()}
            <button
              onClick={onContinue}
              disabled={!canProceed}
              className="px-6 py-2 bg-primary-500 text-white text-[12px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
