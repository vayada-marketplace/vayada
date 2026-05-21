'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import { XMarkIcon, ArrowRightIcon } from '@heroicons/react/24/outline'
import Modal from '@/components/Modal'
import { importService, ExtractedRoomType } from '@/services/import'

interface Props {
  onClose: () => void
}

export default function ListingImportModal({ onClose }: Props) {
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [roomTypes, setRoomTypes] = useState<ExtractedRoomType[]>([])
  const [step, setStep] = useState<'input' | 'select'>('input')

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
      if (preview.roomTypes.length === 1) {
        handleSelect(preview.roomTypes[0])
      } else {
        setStep('select')
      }
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to fetch listing'
      setError(typeof msg === 'string' ? msg : 'Failed to fetch listing')
    } finally {
      setLoading(false)
    }
  }

  const handleSelect = (rt: ExtractedRoomType) => {
    sessionStorage.setItem('importRoomType', JSON.stringify(rt))
    onClose()
    router.push('/rooms/new?from=import')
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

      {/* Step 2: Select room type (only shown when multiple found) */}
      {step === 'select' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            {roomTypes.length} room types found. Select one to pre-fill the room type form.
          </p>

          {roomTypes.map((rt, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleSelect(rt)}
              className="w-full text-left border border-gray-200 rounded-xl p-4 hover:border-primary-300 hover:bg-primary-50/30 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-gray-900 truncate">{rt.name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{rt.shortDescription || rt.description}</p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                    {rt.maxOccupancy > 0 && <span>{rt.maxOccupancy} guests</span>}
                    {rt.size > 0 && <span>{rt.size} m&sup2;</span>}
                    {rt.bedType && <span>{rt.bedType}</span>}
                    {rt.baseRate > 0 && <span>{rt.currency} {rt.baseRate}/night</span>}
                  </div>
                </div>
                <ArrowRightIcon className="w-4 h-4 text-gray-300 group-hover:text-primary-500 shrink-0 ml-3 transition-colors" />
              </div>
            </button>
          ))}

          <button
            onClick={() => { setStep('input'); setError('') }}
            className="w-full px-4 py-2.5 text-sm font-semibold text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Back
          </button>
        </div>
      )}
    </Modal>
  )
}
