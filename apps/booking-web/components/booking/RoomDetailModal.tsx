'use client'

import { useState } from 'react'
import Image from 'next/image'
import { RoomType } from '@/lib/types'
import { useCurrency } from '@/contexts/CurrencyContext'

interface RoomDetailModalProps {
  room: RoomType
  nights: number
  open: boolean
  onClose: () => void
  currentIndex: number
  totalRooms: number
  onPrev: () => void
  onNext: () => void
}

export default function RoomDetailModal({
  room,
  nights,
  open,
  onClose,
  currentIndex,
  totalRooms,
  onPrev,
  onNext,
}: RoomDetailModalProps) {
  const [imgIndex, setImgIndex] = useState(0)
  const [showAllAmenities, setShowAllAmenities] = useState(false)
  const [selectedRate, setSelectedRate] = useState<'flexible' | 'nonrefundable'>('flexible')
  const { formatPrice } = useCurrency()

  if (!open) return null

  const flexibleTotal = room.baseRate * nights
  const nonRefundableNightly = room.nonRefundableRate ?? Math.round(room.baseRate * 0.85)
  const nonRefundableTotal = nonRefundableNightly * nights
  const discount = Math.round((1 - nonRefundableNightly / room.baseRate) * 100)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] overflow-hidden flex flex-col">
        {/* Top bar with nav */}
        <div className="flex items-center justify-end gap-2 px-4 pt-3 pb-1 flex-shrink-0">
          <button onClick={onPrev} className="p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 text-gray-500">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <span className="text-sm text-gray-500 font-medium">{currentIndex + 1} / {totalRooms}</span>
          <button onClick={onNext} className="p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 text-gray-500">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
          <button onClick={onClose} className="p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 text-gray-500 ml-1">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex flex-col md:flex-row overflow-y-auto flex-1">
          {/* Left — Images */}
          <div className="md:w-1/2 flex-shrink-0">
            <div className="relative aspect-[4/3]">
              <Image src={room.images[imgIndex]} alt={room.name} fill className="object-cover" />
              <div className="absolute bottom-3 left-3 bg-black/60 text-white text-xs px-3 py-1 rounded-full">
                {room.name}
              </div>
            </div>
            {room.images.length > 1 && (
              <div className="flex gap-1.5 p-3">
                {room.images.map((img, i) => (
                  <button
                    key={i}
                    onClick={() => setImgIndex(i)}
                    className={`relative w-16 h-12 rounded-lg overflow-hidden border-2 transition-colors ${i === imgIndex ? 'border-primary-500' : 'border-transparent'}`}
                  >
                    <Image src={img} alt="" fill className="object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right — Details */}
          <div className="md:w-1/2 p-6 overflow-y-auto">
            <h2 className="text-2xl font-bold text-gray-900 mb-2">{room.name}</h2>

            <div className="flex items-center gap-3 text-sm text-gray-500 mb-4 flex-wrap">
              <span className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
                {room.size} m&sup2;
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                Up to {room.maxOccupancy} guests
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" /></svg>
                {room.bedType}
              </span>
            </div>

            <p className="text-sm text-gray-600 leading-relaxed mb-4">{room.description}</p>

            {/* Amenities */}
            <button
              onClick={() => setShowAllAmenities(!showAllAmenities)}
              className="text-sm font-medium text-primary-600 hover:text-primary-700 flex items-center gap-1 mb-4"
            >
              View Full Amenities ({room.amenities.length})
              <svg className={`w-4 h-4 transition-transform ${showAllAmenities ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showAllAmenities && (
              <div className="grid grid-cols-2 gap-1.5 mb-4">
                {room.amenities.map((a) => (
                  <span key={a} className="flex items-center gap-1.5 text-sm text-gray-600">
                    <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    {a}
                  </span>
                ))}
              </div>
            )}

            {/* Book Direct Benefits */}
            <div className="bg-gray-50 rounded-xl p-4 mb-4 border border-gray-100">
              <p className="text-sm font-bold text-gray-900 flex items-center gap-2 mb-2">
                <svg className="w-4 h-4 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
                Book Direct Benefits
              </p>
              <div className="space-y-1.5">
                <p className="text-sm text-gray-600 flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  Welcome Drink on Arrival
                </p>
                <p className="text-sm text-gray-600 flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-primary-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  10% Spa Discount
                </p>
                <p className="text-sm text-gray-600 flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  Late Check-out (subject to availability)
                </p>
              </div>
            </div>

            <div className="h-px bg-gray-200 mb-4" />

            {/* Select your rate */}
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Select Your Rate</p>
            <div className="space-y-3">
              {/* Flexible Rate */}
              <button
                onClick={() => setSelectedRate('flexible')}
                className={`w-full text-left rounded-xl border-2 p-4 transition-colors ${selectedRate === 'flexible' ? 'border-primary-500' : 'border-gray-200 hover:border-gray-300'}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    <div>
                      <p className="text-sm font-bold text-gray-900">Flexible Rate</p>
                      <p className="text-xs text-gray-500">Free cancellation until 7 days before</p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-lg font-bold text-gray-900">{formatPrice(room.baseRate, room.currency)}</p>
                    <p className="text-xs text-gray-500">/night</p>
                  </div>
                </div>
              </button>

              {/* Non-Refundable */}
              <button
                onClick={() => setSelectedRate('nonrefundable')}
                className={`w-full text-left rounded-xl border-2 p-4 transition-colors ${selectedRate === 'nonrefundable' ? 'border-primary-500' : 'border-gray-200 hover:border-gray-300'}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    <div>
                      <p className="text-sm font-bold text-gray-900 flex items-center gap-2">
                        Non-Refundable Rate
                        {discount > 0 && <span className="text-[10px] font-bold bg-primary-600 text-white px-1.5 py-0.5 rounded">-{discount}% OFF</span>}
                      </p>
                      <p className="text-xs text-gray-500">Non-refundable</p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-lg font-bold text-gray-900">{formatPrice(nonRefundableNightly, room.currency)}</p>
                    <p className="text-xs text-gray-500">/night</p>
                  </div>
                </div>
              </button>
            </div>

            {room.remainingRooms <= 3 && (
              <p className="text-sm text-gray-500 mt-3 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-gray-900" />
                Only {room.remainingRooms} left at this rate
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
