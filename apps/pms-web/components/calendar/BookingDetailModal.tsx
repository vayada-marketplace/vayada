'use client'

import { useState, useEffect } from 'react'
import { bookingsService, Booking } from '@/services/bookings'
import { formatCurrency } from '@/lib/formatCurrency'
import { CHANNEL_COLORS, getChannelLabel } from '@/lib/constants/statusStyles'
import Modal from '@/components/Modal'

interface CalendarRoom {
  id: string
  roomTypeId: string
  roomTypeName: string
  roomNumber: string
  floor: string
  status: string
}

interface BookingDetailModalProps {
  bookingId: string
  onClose: () => void
  onStatusChange: () => void
  rooms?: CalendarRoom[]
}

export default function BookingDetailModal({
  bookingId,
  onClose,
  onStatusChange,
  rooms = [],
}: BookingDetailModalProps) {
  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [assigningRoom, setAssigningRoom] = useState(false)
  const [selectedRoomId, setSelectedRoomId] = useState<string>('')
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editForm, setEditForm] = useState({
    checkIn: '',
    checkOut: '',
    guestFirstName: '',
    guestLastName: '',
    guestEmail: '',
    guestPhone: '',
    adults: 1,
    children: 0,
    nightlyRate: 0,
    specialRequests: '',
  })

  useEffect(() => {
    bookingsService
      .get(bookingId)
      .then((b) => {
        setBooking(b)
        setEditForm({
          checkIn: b.checkIn,
          checkOut: b.checkOut,
          guestFirstName: b.guestFirstName,
          guestLastName: b.guestLastName,
          guestEmail: b.guestEmail,
          guestPhone: b.guestPhone || '',
          adults: b.adults,
          children: b.children,
          nightlyRate: b.nightlyRate,
          specialRequests: b.specialRequests || '',
        })
      })
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

  const handleAssignRoom = async () => {
    if (!selectedRoomId) return
    setAssigningRoom(true)
    try {
      await bookingsService.assignRoom(bookingId, selectedRoomId)
      onStatusChange()
      onClose()
    } catch (err) {
      console.error(err)
    } finally {
      setAssigningRoom(false)
    }
  }

  const handleSaveEdit = async () => {
    setSaving(true)
    try {
      const updated = await bookingsService.update(bookingId, editForm)
      setBooking(updated)
      setEditing(false)
      onStatusChange()
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const availableRooms = booking
    ? rooms.filter((r) => r.roomTypeId === booking.roomTypeId && r.status === 'available')
    : []

  const channelStyle = CHANNEL_COLORS[booking?.channel?.toLowerCase() || 'direct'] || CHANNEL_COLORS.other

  return (
    <Modal onClose={onClose} maxWidth="lg">
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
        ) : editing ? (
          /* ── EDIT MODE ── */
          <div className="p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-gray-900">Edit Booking</h2>
              <span className="text-sm text-gray-500">{booking.bookingReference}</span>
            </div>

            <div className="space-y-4">
              {/* Dates */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Check-in</label>
                  <input type="date" value={editForm.checkIn} onChange={(e) => setEditForm({ ...editForm, checkIn: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Check-out</label>
                  <input type="date" value={editForm.checkOut} onChange={(e) => setEditForm({ ...editForm, checkOut: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              </div>

              {/* Guest Name */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">First Name</label>
                  <input type="text" value={editForm.guestFirstName} onChange={(e) => setEditForm({ ...editForm, guestFirstName: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Last Name</label>
                  <input type="text" value={editForm.guestLastName} onChange={(e) => setEditForm({ ...editForm, guestLastName: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              </div>

              {/* Contact */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Email</label>
                  <input type="email" value={editForm.guestEmail} onChange={(e) => setEditForm({ ...editForm, guestEmail: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Phone</label>
                  <input type="tel" value={editForm.guestPhone} onChange={(e) => setEditForm({ ...editForm, guestPhone: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              </div>

              {/* Occupancy */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Adults</label>
                  <input type="number" min={1} max={10} value={editForm.adults} onChange={(e) => setEditForm({ ...editForm, adults: Number(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Children</label>
                  <input type="number" min={0} max={10} value={editForm.children} onChange={(e) => setEditForm({ ...editForm, children: Number(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              </div>

              {/* Rate */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Nightly Rate ({booking.currency})</label>
                <input type="number" min={0} step="0.01" value={editForm.nightlyRate} onChange={(e) => setEditForm({ ...editForm, nightlyRate: Number(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>

              {/* Special Requests */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Special Requests</label>
                <textarea value={editForm.specialRequests} onChange={(e) => setEditForm({ ...editForm, specialRequests: e.target.value })} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
            </div>

            {/* Edit Actions */}
            <div className="flex gap-2 mt-5 pt-4 border-t border-gray-200">
              <button
                onClick={() => setEditing(false)}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        ) : (
          /* ── VIEW MODE ── */
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

            {/* Booked / Check-in / Check-out */}
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Booked</p>
                <p className="text-sm font-semibold text-gray-900 mt-0.5">{booking.createdAt ? new Date(booking.createdAt).toLocaleDateString() : '—'}</p>
              </div>
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
                  {booking.roomNumber ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700 mt-1">
                      #{booking.roomNumber}
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 mt-1">
                      Unassigned
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

              {!booking.roomId && availableRooms.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                    Assign to Room
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={selectedRoomId}
                      onChange={(e) => setSelectedRoomId(e.target.value)}
                      className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <option value="">Select a room...</option>
                      {availableRooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          #{r.roomNumber}{r.floor ? ` (Floor ${r.floor})` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleAssignRoom}
                      disabled={!selectedRoomId || assigningRoom}
                      className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {assigningRoom ? 'Assigning...' : 'Assign'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Guest Information */}
            <div className="mb-6">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                Guest Information
              </h3>
              <div className="space-y-1.5">
                {booking.guestEmail ? (
                  <div className="flex items-center gap-2 text-sm">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    <span className="text-gray-700">{booking.guestEmail}</span>
                  </div>
                ) : null}
                {booking.guestPhone ? (
                  <div className="flex items-center gap-2 text-sm">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                    <span className="text-gray-700">{booking.guestPhone}</span>
                  </div>
                ) : null}
                {!booking.guestEmail && !booking.guestPhone && (
                  <p className="text-sm text-gray-400 italic">No contact details available from booking channel</p>
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
                    {formatCurrency(booking.nightlyRate, booking.currency)} x {booking.nights} night{booking.nights !== 1 ? 's' : ''}
                  </span>
                  <span className="font-medium text-gray-900">
                    {formatCurrency(booking.totalAmount, booking.currency)}
                  </span>
                </div>
                <div className="flex justify-between text-sm pt-2 border-t border-gray-200">
                  <span className="font-medium text-gray-900">Total Amount</span>
                  <span className="font-bold text-gray-900">
                    {formatCurrency(booking.totalAmount, booking.currency)}
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

            {booking.estimatedArrivalTime && (
              <div className="mb-6">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                  Estimated Arrival Time
                </h3>
                <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">
                  {booking.estimatedArrivalTime}
                </p>
              </div>
            )}

            {booking.numberOfGuests != null && (
              <div className="mb-6">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                  Number of Guests
                </h3>
                <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">
                  {booking.numberOfGuests}
                </p>
              </div>
            )}

            {/* Actions */}
            {showCancelConfirm ? (
              <div className="pt-2 border-t border-gray-200">
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-3">
                  <p className="text-sm font-medium text-red-800">
                    Are you sure you want to cancel this booking?
                  </p>
                  <p className="text-xs text-red-600 mt-1">
                    {booking.guestFirstName} {booking.guestLastName} &middot; {booking.checkIn} &rarr; {booking.checkOut} &middot; {formatCurrency(booking.totalAmount, booking.currency)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowCancelConfirm(false)}
                    disabled={actionLoading}
                    className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Go Back
                  </button>
                  <button
                    onClick={() => handleStatusUpdate('cancelled')}
                    disabled={actionLoading}
                    className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {actionLoading ? 'Cancelling...' : 'Yes, Cancel'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="pt-2 border-t border-gray-200 space-y-2">
                {/* Edit button — always shown for non-cancelled bookings */}
                {booking.status !== 'cancelled' && (
                  <button
                    onClick={() => setEditing(true)}
                    className="w-full px-4 py-2 text-sm font-medium text-primary-700 border border-primary-300 hover:bg-primary-50 rounded-lg transition-colors"
                  >
                    Edit Booking
                  </button>
                )}
                {booking.status === 'pending' && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleStatusUpdate('confirmed')}
                      disabled={actionLoading}
                      className="flex-1 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setShowCancelConfirm(true)}
                      disabled={actionLoading}
                      className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {booking.status === 'confirmed' && (
                  <button
                    onClick={() => setShowCancelConfirm(true)}
                    disabled={actionLoading}
                    className="w-full px-4 py-2 text-sm font-medium text-red-700 border border-red-300 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel Booking
                  </button>
                )}
              </div>
            )}
          </div>
        )}
    </Modal>
  )
}
