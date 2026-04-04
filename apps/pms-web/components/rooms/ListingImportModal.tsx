'use client'

import React, { useState } from 'react'
import { XMarkIcon, CheckIcon } from '@heroicons/react/24/outline'
import Modal from '@/components/Modal'
import { importService, ExtractedRoomType, ListingImportConfirmRoomType } from '@/services/import'

const AMENITY_OPTIONS = [
  'Free WiFi', 'Flat-screen TV', 'Smart TV', 'Netflix / Streaming', 'Work desk',
  'Laptop-friendly workspace', 'Minibar', 'Refrigerator', 'Microwave', 'Kitchenware',
  'Electric kettle', 'Stovetop', 'Dining table', 'Bath', 'Shower', 'Free toiletries',
  'Hairdryer', 'Toilet', 'Toilet paper', 'Hot Tub', 'Towels', 'Slippers', 'Bathrobe',
  'Air conditioning', 'Heating', 'Fan', 'Fireplace', 'Extra pillows', 'Blackout curtains',
  'Wardrobe', 'Bed linen', 'Washing machine', 'Dryer', 'Iron/Ironing board', 'Clothes rack',
  'Safe', '24hr Security', 'Smoke detector', 'First aid kit', 'Fire extinguisher',
  'Room service', 'Daily housekeeping', 'Concierge', 'Parking', 'Non-smoking',
  'Adults-Only', 'Outdoor furniture',
]

const FEATURE_OPTIONS = [
  'Sea view', 'Ocean view', 'Mountain view', 'Garden view', 'Pool view', 'Beachfront',
  'Forest view', 'City view', 'Lake view', 'River view', 'Private Pool', 'Shared Pool',
  'Hot tub', 'BBQ', 'Outdoor dining area', 'Private terrace', 'Balcony', 'Garden',
  'Rooftop access', 'Entire villa', 'Entire apartment', 'Private entrance',
  'Penthouse', 'Duplex', 'Studio',
]

interface Props {
  onClose: () => void
  onImported: () => void
}

type Step = 'input' | 'preview' | 'result'

export default function ListingImportModal({ onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>('input')
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [roomTypes, setRoomTypes] = useState<ExtractedRoomType[]>([])
  const [selected, setSelected] = useState<Record<number, boolean>>({})
  const [resultMessage, setResultMessage] = useState('')
  const [confirming, setConfirming] = useState(false)

  const normalizeUrl = (u: string): string => {
    let cleaned = u.trim()
    if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
      cleaned = 'https://www.' + cleaned
    }
    return cleaned
  }

  const isValidUrl = (u: string) => {
    try {
      const host = new URL(normalizeUrl(u)).hostname
      return host.includes('booking.com') || host.includes('airbnb')
    } catch { return false }
  }

  const handleFetch = async () => {
    if (!isValidUrl(url)) {
      setError('Please enter a valid Booking.com or Airbnb URL')
      return
    }
    setError('')
    setLoading(true)
    try {
      const preview = await importService.preview(normalizeUrl(url))
      setRoomTypes(preview.roomTypes)
      const sel: Record<number, boolean> = {}
      preview.roomTypes.forEach((_, i) => { sel[i] = true })
      setSelected(sel)
      setStep('preview')
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to fetch listing'
      setError(typeof msg === 'string' ? msg : 'Failed to fetch listing')
    } finally {
      setLoading(false)
    }
  }

  const handleConfirm = async () => {
    const toImport: ListingImportConfirmRoomType[] = roomTypes
      .filter((_, i) => selected[i])
      .map(rt => ({ ...rt, totalRooms: 1 }))

    if (toImport.length === 0) {
      setError('Select at least one room type to import')
      return
    }

    setConfirming(true)
    setError('')
    try {
      const result = await importService.confirm(toImport)
      setResultMessage(result.message)
      setStep('result')
      onImported()
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to create room types'
      setError(typeof msg === 'string' ? msg : 'Failed to create room types')
    } finally {
      setConfirming(false)
    }
  }

  const updateRoomType = (idx: number, updates: Partial<ExtractedRoomType>) => {
    setRoomTypes(prev => prev.map((rt, i) => i === idx ? { ...rt, ...updates } : rt))
  }

  const toggleAmenity = (idx: number, amenity: string) => {
    const rt = roomTypes[idx]
    const has = rt.amenities.includes(amenity)
    updateRoomType(idx, {
      amenities: has ? rt.amenities.filter(a => a !== amenity) : [...rt.amenities, amenity],
    })
  }

  const toggleFeature = (idx: number, feature: string) => {
    const rt = roomTypes[idx]
    const has = rt.features.includes(feature)
    updateRoomType(idx, {
      features: has ? rt.features.filter(f => f !== feature) : [...rt.features, feature],
    })
  }

  const toggleImage = (rtIdx: number, imgUrl: string) => {
    const rt = roomTypes[rtIdx]
    const has = rt.sourceImageUrls.includes(imgUrl)
    updateRoomType(rtIdx, {
      sourceImageUrls: has
        ? rt.sourceImageUrls.filter(u => u !== imgUrl)
        : [...rt.sourceImageUrls, imgUrl],
    })
  }

  return (
    <Modal onClose={onClose} maxWidth="xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-900">Import Listing</h2>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
          <XMarkIcon className="w-5 h-5 text-gray-400" />
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Step 1: URL Input */}
      {step === 'input' && (
        <div>
          <p className="text-sm text-gray-500 mb-4">
            Paste a Booking.com or Airbnb listing URL to automatically extract room type data.
          </p>
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://www.booking.com/hotel/..."
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
            onKeyDown={e => e.key === 'Enter' && handleFetch()}
            autoFocus
          />
          <button
            onClick={handleFetch}
            disabled={loading || !url.trim()}
            className="mt-4 w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Extracting listing data...
              </>
            ) : (
              'Fetch Listing'
            )}
          </button>
          {loading && (
            <p className="mt-2 text-xs text-gray-400 text-center">This may take up to 30 seconds</p>
          )}
        </div>
      )}

      {/* Step 2: Preview */}
      {step === 'preview' && (
        <div className="space-y-4 -mx-6 px-6" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <p className="text-sm text-gray-500">
            {roomTypes.length} room type{roomTypes.length !== 1 ? 's' : ''} found. Review and edit before importing.
          </p>

          {roomTypes.map((rt, idx) => (
            <div key={idx} className={`border rounded-xl overflow-hidden transition-colors ${selected[idx] ? 'border-primary-200 bg-primary-50/20' : 'border-gray-200 bg-gray-50 opacity-60'}`}>
              {/* Header with checkbox */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
                <button
                  type="button"
                  onClick={() => setSelected(prev => ({ ...prev, [idx]: !prev[idx] }))}
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors shrink-0 ${selected[idx] ? 'bg-primary-500 border-primary-500' : 'border-gray-300 bg-white'}`}
                >
                  {selected[idx] && <CheckIcon className="w-3.5 h-3.5 text-white" />}
                </button>
                <input
                  type="text"
                  value={rt.name}
                  onChange={e => updateRoomType(idx, { name: e.target.value })}
                  className="flex-1 text-sm font-semibold text-gray-900 bg-transparent border-none focus:outline-none"
                  placeholder="Room name"
                />
              </div>

              {selected[idx] && (
                <div className="px-4 py-3 space-y-3">
                  {/* Description */}
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Description</label>
                    <textarea
                      value={rt.description}
                      onChange={e => updateRoomType(idx, { description: e.target.value })}
                      rows={3}
                      className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 resize-none"
                    />
                  </div>

                  {/* Row: occupancy, size, bed type, rate */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Max Guests</label>
                      <input
                        type="number"
                        value={rt.maxOccupancy}
                        onChange={e => updateRoomType(idx, { maxOccupancy: parseInt(e.target.value) || 1 })}
                        min={1}
                        className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Size (m2)</label>
                      <input
                        type="number"
                        value={rt.size}
                        onChange={e => updateRoomType(idx, { size: parseInt(e.target.value) || 0 })}
                        min={0}
                        className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Bed Type</label>
                      <input
                        type="text"
                        value={rt.bedType}
                        onChange={e => updateRoomType(idx, { bedType: e.target.value })}
                        className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Rate ({rt.currency})</label>
                      <input
                        type="number"
                        value={rt.baseRate}
                        onChange={e => updateRoomType(idx, { baseRate: parseFloat(e.target.value) || 0 })}
                        min={0}
                        className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                      />
                    </div>
                  </div>

                  {/* Features */}
                  {FEATURE_OPTIONS.some(f => rt.features.includes(f)) && (
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Features</label>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {FEATURE_OPTIONS.filter(f => rt.features.includes(f)).map(f => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => toggleFeature(idx, f)}
                            className="px-2 py-1 text-[11px] rounded-full bg-primary-100 text-primary-700 hover:bg-primary-200 transition-colors"
                          >
                            {f} &times;
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Amenities */}
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Amenities</label>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {AMENITY_OPTIONS.map(a => {
                        const active = rt.amenities.includes(a)
                        return (
                          <button
                            key={a}
                            type="button"
                            onClick={() => toggleAmenity(idx, a)}
                            className={`px-2 py-1 text-[11px] rounded-full transition-colors ${
                              active
                                ? 'bg-primary-100 text-primary-700 hover:bg-primary-200'
                                : 'bg-gray-100 text-gray-400 hover:bg-gray-200 hover:text-gray-600'
                            }`}
                          >
                            {a}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Images */}
                  {rt.sourceImageUrls.length > 0 && (
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                        Images ({rt.sourceImageUrls.length})
                      </label>
                      <div className="mt-1 grid grid-cols-4 gap-2">
                        {rt.sourceImageUrls.map((imgUrl, imgIdx) => (
                          <div
                            key={imgIdx}
                            className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 cursor-pointer group"
                            onClick={() => toggleImage(idx, imgUrl)}
                          >
                            <img
                              src={imgUrl}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          <div className="flex gap-3 pt-2 sticky bottom-0 bg-white py-3 border-t border-gray-100 -mx-6 px-6">
            <button
              onClick={() => { setStep('input'); setError('') }}
              className="flex-1 px-4 py-2.5 text-sm font-semibold text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleConfirm}
              disabled={confirming || !Object.values(selected).some(Boolean)}
              className="flex-1 px-4 py-2.5 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {confirming ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Creating...
                </>
              ) : (
                `Import ${Object.values(selected).filter(Boolean).length} Room Type${Object.values(selected).filter(Boolean).length !== 1 ? 's' : ''}`
              )}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Result */}
      {step === 'result' && (
        <div className="text-center py-4">
          <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
            <CheckIcon className="w-6 h-6 text-green-600" />
          </div>
          <p className="text-sm text-gray-700 font-medium">{resultMessage}</p>
          <p className="text-xs text-gray-400 mt-1">You can edit the room types from the list.</p>
          <button
            onClick={onClose}
            className="mt-4 px-6 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
          >
            Done
          </button>
        </div>
      )}
    </Modal>
  )
}
