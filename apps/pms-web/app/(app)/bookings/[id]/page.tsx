'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeftIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline'
import { bookingsService, Booking, BookingChangeRequest } from '@/services/bookings'
import ConfirmDialog from '@/components/ConfirmDialog'
import Modal from '@/components/Modal'
import { formatCurrency } from '@/lib/formatCurrency'
import { BOOKING_STATUS_STYLES, PAYMENT_STATUS_STYLES, getPaymentStatusLabel } from '@/lib/constants/statusStyles'

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
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string
    variant?: 'danger' | 'default'
    confirmLabel?: string
    onConfirm: () => void
  } | null>(null)
  const [changeRequest, setChangeRequest] = useState<BookingChangeRequest | null>(null)
  const [decideOpen, setDecideOpen] = useState<'approve' | 'decline' | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const [decidingChange, setDecidingChange] = useState(false)

  const loadChangeRequest = useCallback(async () => {
    try {
      const cr = await bookingsService.getChangeRequest(params.id)
      setChangeRequest(cr)
    } catch (err) {
      console.error(err)
    }
  }, [params.id])

  useEffect(() => {
    bookingsService.get(params.id)
      .then(setBooking)
      .catch(console.error)
      .finally(() => setLoading(false))
    loadChangeRequest()
  }, [params.id, loadChangeRequest])

  const doAction = useCallback(async (action: () => Promise<Booking>, errorMsg: string) => {
    setUpdating(true)
    setError('')
    try {
      const updated = await action()
      setBooking(updated)
    } catch (err: any) {
      setError(err.message || errorMsg)
    } finally {
      setUpdating(false)
    }
  }, [])

  const handleAccept = () => {
    setConfirmDialog({
      message: 'Are you sure you want to accept this booking? Payment will be captured.',
      confirmLabel: 'Accept',
      onConfirm: () => {
        setConfirmDialog(null)
        doAction(() => bookingsService.acceptBooking(params.id), 'Failed to accept booking')
      },
    })
  }

  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const handleReject = () => {
    setRejectReason('')
    setRejectOpen(true)
  }

  const confirmReject = () => {
    setRejectOpen(false)
    doAction(() => bookingsService.rejectBooking(params.id, rejectReason.trim() || undefined), 'Failed to reject booking')
  }

  const handleApproveChange = async () => {
    setDecidingChange(true)
    setError('')
    try {
      const cr = await bookingsService.approveChangeRequest(params.id)
      setChangeRequest(cr)
      const refreshed = await bookingsService.get(params.id)
      setBooking(refreshed)
      setDecideOpen(null)
    } catch (err: any) {
      setError(err.message || 'Failed to approve change request')
    } finally {
      setDecidingChange(false)
    }
  }

  const handleDeclineChange = async () => {
    setDecidingChange(true)
    setError('')
    try {
      const cr = await bookingsService.declineChangeRequest(params.id, declineReason.trim() || undefined)
      setChangeRequest(cr)
      setDecideOpen(null)
    } catch (err: any) {
      setError(err.message || 'Failed to decline change request')
    } finally {
      setDecidingChange(false)
    }
  }

  const updateStatus = (status: 'confirmed' | 'cancelled') => {
    const label = status === 'confirmed' ? 'confirm' : 'cancel'
    setConfirmDialog({
      message: `Are you sure you want to ${label} this booking?`,
      variant: status === 'cancelled' ? 'danger' : 'default',
      confirmLabel: status === 'confirmed' ? 'Confirm' : 'Cancel Booking',
      onConfirm: () => {
        setConfirmDialog(null)
        doAction(() => bookingsService.updateStatus(params.id, status), 'Failed to update status')
      },
    })
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
        <span className={`ml-2 inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${BOOKING_STATUS_STYLES[booking.status] || ''}`}>
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

      {changeRequest && changeRequest.status === 'pending' && (
        <div className="mb-4 p-5 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <p className="text-sm font-semibold text-blue-900">Change Request Pending</p>
              <p className="text-xs text-blue-700">
                The guest has requested an edit to this booking. Approve to apply
                the new details, or decline to keep the booking as-is.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm mb-4">
            <div>
              <p className="text-blue-900 font-medium">Current</p>
              <p className="text-blue-800">{changeRequest.oldCheckIn} → {changeRequest.oldCheckOut}</p>
              <p className="text-blue-800">Total: {formatCurrency(changeRequest.oldTotal, changeRequest.currency)}</p>
            </div>
            <div>
              <p className="text-blue-900 font-medium">Requested</p>
              <p className="text-blue-800">{changeRequest.requestedCheckIn} → {changeRequest.requestedCheckOut}</p>
              <p className="text-blue-800">Total: {formatCurrency(changeRequest.newTotal, changeRequest.currency)}</p>
              {changeRequest.requestedAddonNames.length > 0 && (
                <p className="text-blue-800 mt-1">
                  Add-ons: {changeRequest.requestedAddonNames.join(', ')}
                </p>
              )}
            </div>
          </div>
          <div className="text-sm text-blue-900 font-medium mb-4">
            Price difference: {changeRequest.priceDifference === 0
              ? 'No change'
              : (changeRequest.priceDifference > 0
                  ? `+${formatCurrency(changeRequest.priceDifference, changeRequest.currency)} (guest must pay)`
                  : `${formatCurrency(changeRequest.priceDifference, changeRequest.currency)} (refund where applicable)`
                )
            }
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => setDecideOpen('approve')}
              disabled={decidingChange}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              <CheckCircleIcon className="w-4 h-4" />
              Approve Change
            </button>
            <button
              onClick={() => { setDeclineReason(''); setDecideOpen('decline') }}
              disabled={decidingChange}
              className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              <XCircleIcon className="w-4 h-4" />
              Decline Change
            </button>
          </div>
        </div>
      )}

      {changeRequest && changeRequest.status !== 'pending' && (
        <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
          Last change request was{' '}
          <span className="font-medium text-gray-800">{changeRequest.status}</span>
          {changeRequest.decidedAt && (
            <> on {new Date(changeRequest.decidedAt).toLocaleString()}</>
          )}
          {changeRequest.declineReason && (
            <span className="block mt-1 text-xs text-gray-500">
              Reason: {changeRequest.declineReason}
            </span>
          )}
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
            {booking.guestCountry && (
              <div>
                <p className="text-gray-500">Country</p>
                <p className="font-medium text-gray-900">{booking.guestCountry}</p>
              </div>
            )}
          </div>
          {booking.specialRequests && (
            <div className="mt-4 text-sm">
              <p className="text-gray-500">Special Requests</p>
              <p className="font-medium text-gray-900 whitespace-pre-wrap">{booking.specialRequests}</p>
            </div>
          )}
          {booking.estimatedArrivalTime && (
            <div className="mt-4 text-sm">
              <p className="text-gray-500">Estimated Arrival Time</p>
              <p className="font-medium text-gray-900">{booking.estimatedArrivalTime}</p>
            </div>
          )}
          {booking.numberOfGuests != null && (
            <div className="mt-4 text-sm">
              <p className="text-gray-500">Number of Guests</p>
              <p className="font-medium text-gray-900">{booking.numberOfGuests}</p>
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

        {/* Addons */}
        {booking.addonIds.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Add-ons</h2>
            <div className="space-y-2 text-sm">
              {booking.addonIds.map((addonId, idx) => {
                const qty = booking.addonQuantities[addonId]
                const name = booking.addonNames?.[idx] || addonId
                return (
                  <div key={addonId} className="flex justify-between">
                    <span className="text-gray-700">{name}</span>
                    {qty && (
                      <span className="text-gray-500">{qty} night{qty !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

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
                  {getPaymentStatusLabel(booking.paymentStatus)}
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
              <span className="font-medium text-gray-900">{formatCurrency(booking.nightlyRate, booking.currency)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Nights</span>
              <span className="font-medium text-gray-900">{booking.nights}</span>
            </div>
            {booking.addonTotal > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-500">Addons</span>
                <span className="font-medium text-gray-900">{booking.currency} {booking.addonTotal.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between pt-2 border-t border-gray-100">
              <span className="font-semibold text-gray-900">Total</span>
              <span className="font-bold text-gray-900">{formatCurrency(booking.totalAmount, booking.currency)}</span>
            </div>
            {booking.platformFeeAmount != null && booking.platformFeeAmount > 0 && (
              <div className="flex justify-between pt-2 border-t border-gray-100">
                <span className="text-gray-500">Platform Fee</span>
                <span className="font-medium text-gray-600">-{formatCurrency(booking.platformFeeAmount, booking.currency)}</span>
              </div>
            )}
            {booking.affiliateCommissionAmount != null && booking.affiliateCommissionAmount > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-500">Affiliate Commission</span>
                <span className="font-medium text-gray-600">{formatCurrency(booking.affiliateCommissionAmount, booking.currency)}</span>
              </div>
            )}
            {booking.propertyPayoutAmount != null && booking.propertyPayoutAmount !== booking.totalAmount && (
              <div className="flex justify-between pt-2 border-t border-gray-100">
                <span className="font-semibold text-gray-900">Property Payout</span>
                <span className="font-bold text-green-600">{formatCurrency(booking.propertyPayoutAmount, booking.currency)}</span>
              </div>
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

      </div>

      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          variant={confirmDialog.variant}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {decideOpen === 'approve' && changeRequest && (
        <Modal onClose={() => setDecideOpen(null)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Approve Change Request?</h3>
          <p className="text-sm text-gray-600 mb-4">
            The booking will be updated to use the requested dates and add-ons.
            {changeRequest.priceDifference > 0 && (
              <> The guest will be asked to pay the {formatCurrency(changeRequest.priceDifference, changeRequest.currency)} difference.</>
            )}
            {changeRequest.priceDifference < 0 && (
              <> The total will decrease by {formatCurrency(Math.abs(changeRequest.priceDifference), changeRequest.currency)} — handle any refund manually.</>
            )}
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDecideOpen(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApproveChange}
              disabled={decidingChange}
              className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg disabled:opacity-50 transition-colors"
            >
              {decidingChange ? 'Approving…' : 'Approve'}
            </button>
          </div>
        </Modal>
      )}

      {decideOpen === 'decline' && (
        <Modal onClose={() => setDecideOpen(null)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Decline Change Request</h3>
          <p className="text-sm text-gray-600 mb-4">
            The booking will stay as-is. The guest will receive an email with your reason.
          </p>
          <textarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="Reason (optional — will be included in the guest's email)"
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent mb-4 resize-none"
          />
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDecideOpen(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDeclineChange}
              disabled={decidingChange}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50 transition-colors"
            >
              {decidingChange ? 'Declining…' : 'Decline'}
            </button>
          </div>
        </Modal>
      )}

      {rejectOpen && (
        <Modal onClose={() => setRejectOpen(false)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Reject Booking</h3>
          <p className="text-sm text-gray-600 mb-4">Are you sure you want to reject this booking? The payment hold will be released.</p>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection (optional — will be included in the guest's email)"
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent mb-4 resize-none"
          />
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setRejectOpen(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={confirmReject}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
            >
              Reject
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
