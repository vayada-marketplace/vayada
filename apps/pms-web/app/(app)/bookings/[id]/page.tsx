'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeftIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline'
import { bookingsService, Booking } from '@/services/bookings'

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  confirmed: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
  expired: 'bg-gray-100 text-gray-600',
}

const PAYMENT_STATUS_STYLES: Record<string, string> = {
  unpaid: 'bg-gray-100 text-gray-600',
  authorized: 'bg-blue-100 text-blue-700',
  captured: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
  refunded: 'bg-purple-100 text-purple-700',
  partially_refunded: 'bg-purple-100 text-purple-700',
  failed: 'bg-red-100 text-red-600',
  pay_at_property: 'bg-amber-100 text-amber-700',
}

function CountdownTimer({ deadline }: { deadline: string }) {
  const [timeLeft, setTimeLeft] = useState('')

  useEffect(() => {
    const update = () => {
      const now = new Date().getTime()
      const end = new Date(deadline).getTime()
      const diff = end - now

      if (diff <= 0) {
        setTimeLeft('Expired')
        return
      }

      const hours = Math.floor(diff / (1000 * 60 * 60))
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
      setTimeLeft(`${hours}h ${minutes}m remaining`)
    }

    update()
    const interval = setInterval(update, 60000)
    return () => clearInterval(interval)
  }, [deadline])

  const isUrgent = (() => {
    const diff = new Date(deadline).getTime() - Date.now()
    return diff > 0 && diff < 4 * 60 * 60 * 1000 // Less than 4 hours
  })()

  return (
    <span className={`text-sm font-medium ${isUrgent ? 'text-red-600' : 'text-amber-600'}`}>
      {timeLeft}
    </span>
  )
}

export default function BookingDetailPage({ params }: { params: { id: string } }) {
  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    bookingsService.get(params.id)
      .then(setBooking)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [params.id])

  const handleAccept = async () => {
    if (!confirm('Are you sure you want to accept this booking? Payment will be captured.')) return
    setUpdating(true)
    setError('')
    try {
      const updated = await bookingsService.acceptBooking(params.id)
      setBooking(updated)
    } catch (err: any) {
      setError(err.message || 'Failed to accept booking')
    } finally {
      setUpdating(false)
    }
  }

  const handleReject = async () => {
    if (!confirm('Are you sure you want to reject this booking? The card hold will be released.')) return
    setUpdating(true)
    setError('')
    try {
      const updated = await bookingsService.rejectBooking(params.id)
      setBooking(updated)
    } catch (err: any) {
      setError(err.message || 'Failed to reject booking')
    } finally {
      setUpdating(false)
    }
  }

  const updateStatus = async (status: 'confirmed' | 'cancelled') => {
    if (!confirm(`Are you sure you want to ${status === 'confirmed' ? 'confirm' : 'cancel'} this booking?`)) return
    setUpdating(true)
    setError('')
    try {
      const updated = await bookingsService.updateStatus(params.id, status)
      setBooking(updated)
    } catch (err: any) {
      setError(err.message || 'Failed to update status')
    } finally {
      setUpdating(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    )
  }

  if (!booking) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Booking not found.</p>
      </div>
    )
  }

  const isPending = booking.status === 'pending'
  const hasDeadline = isPending && booking.hostResponseDeadline

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/bookings" className="text-gray-400 hover:text-gray-600">
          <ArrowLeftIcon className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-gray-900">
          Booking {booking.bookingReference}
        </h1>
        <span className={`ml-2 inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[booking.status] || ''}`}>
          {booking.status}
        </span>
      </div>

      {/* Deadline banner for pending bookings */}
      {hasDeadline && (
        <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-800">Action Required</p>
            <p className="text-xs text-amber-600">This booking will auto-expire if not responded to in time.</p>
          </div>
          <CountdownTimer deadline={booking.hostResponseDeadline!} />
        </div>
      )}

      {booking.guestWithdrawn && (
        <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
          The guest withdrew this booking request.
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {/* Guest Information */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Guest Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Name</p>
              <p className="font-medium text-gray-900">{booking.guestFirstName} {booking.guestLastName}</p>
            </div>
            <div>
              <p className="text-gray-500">Email</p>
              <p className="font-medium text-gray-900">{booking.guestEmail}</p>
            </div>
            <div>
              <p className="text-gray-500">Phone</p>
              <p className="font-medium text-gray-900">{booking.guestPhone}</p>
            </div>
          </div>
          {booking.specialRequests && (
            <div className="mt-4 text-sm">
              <p className="text-gray-500">Special Requests</p>
              <p className="font-medium text-gray-900 whitespace-pre-wrap">{booking.specialRequests}</p>
            </div>
          )}
        </div>

        {/* Stay Details */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Stay Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Room Type</p>
              <p className="font-medium text-gray-900">{booking.roomName}</p>
            </div>
            <div>
              <p className="text-gray-500">Check-in</p>
              <p className="font-medium text-gray-900">{booking.checkIn}</p>
            </div>
            <div>
              <p className="text-gray-500">Check-out</p>
              <p className="font-medium text-gray-900">{booking.checkOut}</p>
            </div>
            <div>
              <p className="text-gray-500">Duration</p>
              <p className="font-medium text-gray-900">{booking.nights} night{booking.nights !== 1 ? 's' : ''}</p>
            </div>
            <div>
              <p className="text-gray-500">Guests</p>
              <p className="font-medium text-gray-900">
                {booking.adults} adult{booking.adults !== 1 ? 's' : ''}
                {booking.children > 0 && `, ${booking.children} child${booking.children !== 1 ? 'ren' : ''}`}
              </p>
            </div>
          </div>
        </div>

        {/* Payment Information */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Payment</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Method</p>
              <p className="font-medium text-gray-900">
                {booking.paymentMethod === 'card' ? 'Card' : booking.paymentMethod === 'pay_at_property' ? 'Pay at Property' : booking.paymentMethod || 'N/A'}
              </p>
            </div>
            <div>
              <p className="text-gray-500">Payment Status</p>
              {booking.paymentStatus && (
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${PAYMENT_STATUS_STYLES[booking.paymentStatus] || 'bg-gray-100 text-gray-600'}`}>
                  {booking.paymentStatus.replace('_', ' ')}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Pricing & Split */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Pricing</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Nightly Rate</span>
              <span className="font-medium text-gray-900">{booking.currency} {booking.nightlyRate.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Nights</span>
              <span className="font-medium text-gray-900">{booking.nights}</span>
            </div>
            <div className="flex justify-between pt-2 border-t border-gray-100">
              <span className="font-semibold text-gray-900">Total</span>
              <span className="font-bold text-gray-900">{booking.currency} {booking.totalAmount.toFixed(2)}</span>
            </div>
            {booking.platformFeeAmount != null && (
              <>
                <div className="flex justify-between pt-2 border-t border-gray-100">
                  <span className="text-gray-500">Platform Fee</span>
                  <span className="font-medium text-gray-600">-{booking.currency} {booking.platformFeeAmount.toFixed(2)}</span>
                </div>
                {booking.affiliateCommissionAmount != null && booking.affiliateCommissionAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Affiliate Commission</span>
                    <span className="font-medium text-gray-600">{booking.currency} {booking.affiliateCommissionAmount.toFixed(2)}</span>
                  </div>
                )}
                {booking.propertyPayoutAmount != null && (
                  <div className="flex justify-between pt-2 border-t border-gray-100">
                    <span className="font-semibold text-gray-900">Property Payout</span>
                    <span className="font-bold text-green-600">{booking.currency} {booking.propertyPayoutAmount.toFixed(2)}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Actions — Accept/Reject for pending with payment flow */}
        {isPending && booking.hostResponseDeadline && (
          <div className="flex gap-3">
            <button
              onClick={handleAccept}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              <CheckCircleIcon className="w-4 h-4" />
              Accept Booking
            </button>
            <button
              onClick={handleReject}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              <XCircleIcon className="w-4 h-4" />
              Reject Booking
            </button>
          </div>
        )}

        {/* Legacy actions for bookings without payment flow */}
        {isPending && !booking.hostResponseDeadline && (
          <div className="flex gap-3">
            <button
              onClick={() => updateStatus('confirmed')}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              <CheckCircleIcon className="w-4 h-4" />
              Confirm Booking
            </button>
            <button
              onClick={() => updateStatus('cancelled')}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              <XCircleIcon className="w-4 h-4" />
              Cancel Booking
            </button>
          </div>
        )}

        {booking.status === 'confirmed' && (
          <div>
            <button
              onClick={() => updateStatus('cancelled')}
              disabled={updating}
              className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              <XCircleIcon className="w-4 h-4" />
              Cancel Booking
            </button>
          </div>
        )}

        {/* Metadata */}
        <div className="text-xs text-gray-400">
          <p>Created: {booking.createdAt}</p>
          <p>Last updated: {booking.updatedAt}</p>
        </div>
      </div>
    </div>
  )
}
