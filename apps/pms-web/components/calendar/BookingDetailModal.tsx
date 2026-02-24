'use client'

import { useState, useEffect } from 'react'
import { bookingsService, Booking } from '@/services/bookings'

interface BookingDetailModalProps {
  bookingId: string
  onClose: () => void
  onStatusChange: () => void
}

const CHANNEL_COLORS: Record<string, { bg: string; text: string }> = {
  direct: { bg: 'bg-blue-100', text: 'text-blue-700' },
  airbnb: { bg: 'bg-pink-100', text: 'text-pink-700' },
  'booking.com': { bg: 'bg-indigo-100', text: 'text-indigo-700' },
  expedia: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  other: { bg: 'bg-gray-100', text: 'text-gray-700' },
}

function getChannelLabel(channel: string): string {
  const labels: Record<string, string> = {
    direct: 'Direct',
    airbnb: 'Airbnb',
    'booking.com': 'Booking.com',
    expedia: 'Expedia',
    other: 'Other',
  }
  return labels[channel] || channel
}

export default function BookingDetailModal({
  bookingId,
  onClose,
  onStatusChange,
}: BookingDetailModalProps) {
  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => {
    bookingsService
      .get(bookingId)
      .then(setBooking)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [bookingId])

  const handleStatusUpdate = async (status: 'confirmed' | 'cancelled') => {
    setActionLoading(true)
    try {
      await bookingsService.updateStatus(bookingId, status)
      onStatusChange()
      onClose()
    } catch (err) {
      console.error(err)
    } finally {
      setActionLoading(false)
    }
  }

  const channelStyle = CHANNEL_COLORS[booking?.channel || 'direct'] || CHANNEL_COLORS.other

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 z-10"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {loading ? (
          <div className="p-8">
            <div className="animate-pulse space-y-4">
              <div className="h-6 bg-gray-200 rounded w-2/3" />
              <div className="h-4 bg-gray-200 rounded w-1/2" />
              <div className="h-20 bg-gray-200 rounded" />
            </div>
          </div>
        ) : !booking ? (
          <div className="p-8 text-center text-gray-500">Booking not found</div>
        ) : (
          <div className="p-6">
            {/* Header */}
            <div className="mb-6">
              <h2 className="text-xl font-bold text-gray-900">
                {booking.guestFirstName} {booking.guestLastName}
              </h2>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm text-gray-500">{booking.bookingReference}</span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${channelStyle.bg} ${channelStyle.text}`}
                >
                  {getChannelLabel(booking.channel)}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    booking.status === 'confirmed'
                      ? 'bg-green-100 text-green-700'
                      : booking.status === 'cancelled'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                </span>
              </div>
            </div>

            {/* Check-in / Check-out */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Check-in</p>
                <p className="text-sm font-semibold text-gray-900 mt-0.5">{booking.checkIn}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Check-out</p>
                <p className="text-sm font-semibold text-gray-900 mt-0.5">{booking.checkOut}</p>
              </div>
            </div>

            {/* Room info */}
            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">{booking.roomName}</p>
                  {booking.roomNumber && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700 mt-1">
                      #{booking.roomNumber}
                    </span>
                  )}
                </div>
                <div className="text-right text-sm text-gray-600">
                  <p>{booking.nights} night{booking.nights !== 1 ? 's' : ''}</p>
                  <p>
                    {booking.adults} adult{booking.adults !== 1 ? 's' : ''}
                    {booking.children > 0 && `, ${booking.children} child${booking.children !== 1 ? 'ren' : ''}`}
                  </p>
                </div>
              </div>
            </div>

            {/* Guest Information */}
            <div className="mb-6">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                Guest Information
              </h3>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-sm">
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <span className="text-gray-700">{booking.guestEmail}</span>
                </div>
                {booking.guestPhone && (
                  <div className="flex items-center gap-2 text-sm">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                    <span className="text-gray-700">{booking.guestPhone}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Payment Details */}
            <div className="mb-6">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                Payment Details
              </h3>
              <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">
                    {booking.currency} {booking.nightlyRate.toFixed(2)} x {booking.nights} night{booking.nights !== 1 ? 's' : ''}
                  </span>
                  <span className="font-medium text-gray-900">
                    {booking.currency} {booking.totalAmount.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-sm pt-2 border-t border-gray-200">
                  <span className="font-medium text-gray-900">Total Amount</span>
                  <span className="font-bold text-gray-900">
                    {booking.currency} {booking.totalAmount.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            {/* Special Requests */}
            {booking.specialRequests && (
              <div className="mb-6">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                  Special Requests
                </h3>
                <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">
                  {booking.specialRequests}
                </p>
              </div>
            )}

            {/* Actions */}
            {booking.status === 'pending' && (
              <div className="flex gap-2 pt-2 border-t border-gray-200">
                <button
                  onClick={() => handleStatusUpdate('confirmed')}
                  disabled={actionLoading}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  Confirm
                </button>
                <button
                  onClick={() => handleStatusUpdate('cancelled')}
                  disabled={actionLoading}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            )}
            {booking.status === 'confirmed' && (
              <div className="pt-2 border-t border-gray-200">
                <button
                  onClick={() => handleStatusUpdate('cancelled')}
                  disabled={actionLoading}
                  className="w-full px-4 py-2 text-sm font-medium text-red-700 border border-red-300 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel Booking
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
