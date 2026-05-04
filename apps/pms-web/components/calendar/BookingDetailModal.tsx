'use client'

import { useState, useEffect } from 'react'
import { bookingsService, Booking } from '@/services/bookings'
import { formatCurrency } from '@/lib/formatCurrency'
import {
  CHANNEL_COLORS,
  getChannelLabel,
  normalizeChannelKey,
} from '@/lib/constants/statusStyles'
import Modal from '@/components/Modal'

interface CalendarRoom {
  id: string
  roomTypeId: string
  roomTypeName: string
  roomNumber: string
  floor: string
  status: string
}

interface CalendarBookingLite {
  id: string
  roomId: string | null
  roomTypeId?: string
  checkIn: string
  checkOut: string
  status: string
  guestFirstName?: string
  guestLastName?: string
}

interface BookingDetailModalProps {
  bookingId: string
  onClose: () => void
  onStatusChange: () => void
  rooms?: CalendarRoom[]
  bookings?: CalendarBookingLite[]
}

type View = 'detail' | 'roomPicker' | 'swapConfirm' | 'moveSuccess'

interface SwapPlan {
  partnerBookingId: string
  partnerBookingLabel: string
  partnerCheckIn: string
  partnerCheckOut: string
  partnerCurrentRoomId: string
  partnerDestinationRoomId: string
  // Room the *source* booking ends up in (always partner's current room).
  sourceDestinationRoomId: string
}

const datesOverlap = (
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean => aStart < bEnd && aEnd > bStart

export default function BookingDetailModal({
  bookingId,
  onClose,
  onStatusChange,
  rooms = [],
  bookings = [],
}: BookingDetailModalProps) {
  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [assigningRoom, setAssigningRoom] = useState(false)
  const [selectedRoomId, setSelectedRoomId] = useState<string>('')
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<View>('detail')
  const [pickerSelectedRoomId, setPickerSelectedRoomId] = useState<string>('')
  const [pendingSwap, setPendingSwap] = useState<SwapPlan | null>(null)
  const [movingRoom, setMovingRoom] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [movedToRoomNumber, setMovedToRoomNumber] = useState<string>('')
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

  // Candidate rooms for the "Move to another room" picker: same room type,
  // not the current room. Each is annotated with one of three states:
  //   - available  → fully free for the booking's dates → simple move
  //   - swap       → occupied, but a swap with the occupier resolves cleanly
  //                 (backend will atomically exchange the two assignments)
  //   - blocked    → occupied with no swap path → disabled
  // All availability/swap math is computed locally from the already-loaded
  // calendar bookings; the backend re-validates on submit.
  type Candidate =
    | { room: typeof rooms[number]; kind: 'available' }
    | {
        room: typeof rooms[number]
        kind: 'swap'
        partner: CalendarBookingLite
        partnerDestinationRoomId: string
      }
    | { room: typeof rooms[number]; kind: 'blocked' }

  const candidates: Candidate[] = booking
    ? rooms
        .filter((r) => r.roomTypeId === booking.roomTypeId && r.id !== booking.roomId)
        .map((r): Candidate => {
          const occupier = bookings.find(
            (b) =>
              b.id !== booking.id &&
              b.roomId === r.id &&
              b.status !== 'cancelled' &&
              datesOverlap(booking.checkIn, booking.checkOut, b.checkIn, b.checkOut),
          )
          if (!occupier) return { room: r, kind: 'available' }
          // Swap eligibility:
          //  • Source assigned: occupier moves into source's room. Verify
          //    occupier's dates fit there (no other conflict).
          //  • Source unassigned: occupier needs a different free same-type
          //    room. Find one that is free for occupier's dates.
          if (booking.roomId) {
            const sourceRoomId = booking.roomId
            const conflictInSourceRoom = bookings.some(
              (b) =>
                b.id !== booking.id &&
                b.id !== occupier.id &&
                b.roomId === sourceRoomId &&
                b.status !== 'cancelled' &&
                datesOverlap(occupier.checkIn, occupier.checkOut, b.checkIn, b.checkOut),
            )
            if (conflictInSourceRoom) return { room: r, kind: 'blocked' }
            return {
              room: r,
              kind: 'swap',
              partner: occupier,
              partnerDestinationRoomId: sourceRoomId,
            }
          } else {
            const freeForOccupier = rooms.find(
              (rr) =>
                rr.roomTypeId === booking.roomTypeId &&
                rr.id !== r.id &&
                !bookings.some(
                  (b) =>
                    b.id !== booking.id &&
                    b.id !== occupier.id &&
                    b.roomId === rr.id &&
                    b.status !== 'cancelled' &&
                    datesOverlap(occupier.checkIn, occupier.checkOut, b.checkIn, b.checkOut),
                ),
            )
            if (!freeForOccupier) return { room: r, kind: 'blocked' }
            return {
              room: r,
              kind: 'swap',
              partner: occupier,
              partnerDestinationRoomId: freeForOccupier.id,
            }
          }
        })
    : []

  const currentRoom = booking?.roomId
    ? rooms.find((r) => r.id === booking.roomId) || null
    : null

  const partnerLabel = (p: CalendarBookingLite): string => {
    const name = `${p.guestFirstName ?? ''} ${p.guestLastName ?? ''}`.trim()
    return name || 'occupied'
  }

  const enterRoomPicker = () => {
    setMoveError(null)
    setPickerSelectedRoomId('')
    setPendingSwap(null)
    setView('roomPicker')
  }

  const selectedCandidate = pickerSelectedRoomId
    ? candidates.find((c) => c.room.id === pickerSelectedRoomId) ?? null
    : null

  const handlePickerContinue = () => {
    if (!booking || !selectedCandidate) return
    if (selectedCandidate.kind === 'swap') {
      setPendingSwap({
        partnerBookingId: selectedCandidate.partner.id,
        partnerBookingLabel: partnerLabel(selectedCandidate.partner),
        partnerCheckIn: selectedCandidate.partner.checkIn,
        partnerCheckOut: selectedCandidate.partner.checkOut,
        partnerCurrentRoomId: selectedCandidate.room.id,
        partnerDestinationRoomId: selectedCandidate.partnerDestinationRoomId,
        sourceDestinationRoomId: selectedCandidate.room.id,
      })
      setMoveError(null)
      setView('swapConfirm')
      return
    }
    void handleConfirmMove()
  }

  const handleConfirmMove = async () => {
    if (!booking || !pickerSelectedRoomId) return
    setMoveError(null)
    setMovingRoom(true)
    try {
      const updated = await bookingsService.moveRoom(bookingId, pickerSelectedRoomId)
      const target = rooms.find((r) => r.id === pickerSelectedRoomId)
      setMovedToRoomNumber(target?.roomNumber || updated.roomNumber || '')
      setBooking(updated)
      setView('moveSuccess')
      onStatusChange()
      window.setTimeout(() => {
        // Use the functional setter so we don't bounce out if the user
        // already navigated away.
        setView((v) => (v === 'moveSuccess' ? 'detail' : v))
      }, 1000)
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail ||
        err?.data?.detail ||
        err?.message ||
        'Failed to move booking'
      setMoveError(typeof detail === 'string' ? detail : 'Failed to move booking')
    } finally {
      setMovingRoom(false)
    }
  }

  const handleConfirmSwap = async () => {
    if (!booking || !pendingSwap) return
    setMoveError(null)
    setMovingRoom(true)
    try {
      // partnerDestinationRoomId is only meaningful when source is unassigned.
      // For the standard 2-way swap (source has a room) the backend infers it.
      const partnerDest = booking.roomId ? undefined : pendingSwap.partnerDestinationRoomId
      const updated = await bookingsService.swapRoom(
        bookingId,
        pendingSwap.partnerBookingId,
        partnerDest,
      )
      const target = rooms.find((r) => r.id === pendingSwap.sourceDestinationRoomId)
      setMovedToRoomNumber(target?.roomNumber || updated.roomNumber || '')
      setBooking(updated)
      setView('moveSuccess')
      onStatusChange()
      window.setTimeout(() => {
        setView((v) => (v === 'moveSuccess' ? 'detail' : v))
      }, 1200)
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail ||
        err?.data?.detail ||
        err?.message ||
        'Failed to swap rooms'
      setMoveError(typeof detail === 'string' ? detail : 'Failed to swap rooms')
      setView('swapConfirm')
    } finally {
      setMovingRoom(false)
    }
  }

  const channelStyle =
    CHANNEL_COLORS[normalizeChannelKey(booking?.channel)] || CHANNEL_COLORS.other

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
        ) : view === 'roomPicker' ? (
          /* ── ROOM PICKER ── */
          <div className="p-6">
            <div className="flex items-center gap-3 mb-1">
              <button
                onClick={() => setView('detail')}
                aria-label="Back"
                className="text-gray-500 hover:text-gray-800 -ml-1 p-1 rounded hover:bg-gray-100 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <h2 className="text-lg font-bold text-gray-900">
                {booking.roomId ? 'Move to another room' : 'Assign room'}
              </h2>
            </div>
            <p className="text-sm text-gray-500 mb-4 ml-8">
              {booking.guestFirstName} {booking.guestLastName} &middot;{' '}
              {booking.checkIn} &rarr; {booking.checkOut}
            </p>

            {currentRoom && (
              <div className="mb-3">
                <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                  Current room
                </p>
                <div className="flex items-center justify-between px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg opacity-70">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-gray-300" />
                    <span className="text-sm font-medium text-gray-700">
                      #{currentRoom.roomNumber}
                      {currentRoom.floor ? ` (Floor ${currentRoom.floor})` : ''}
                    </span>
                    <span className="text-xs text-gray-400">
                      &middot; {currentRoom.roomTypeName}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {candidates.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-lg">
                No other rooms of this type available.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {candidates.map((cand) => {
                  const { room, kind } = cand
                  const isSelected = pickerSelectedRoomId === room.id
                  const enabled = kind !== 'blocked'
                  const dotColor =
                    kind === 'available'
                      ? 'bg-green-500'
                      : kind === 'swap'
                      ? 'bg-amber-500'
                      : 'bg-gray-300'
                  const badgeText =
                    kind === 'available'
                      ? 'Available'
                      : kind === 'swap'
                      ? 'Swap'
                      : 'Unavailable'
                  const badgeStyle =
                    kind === 'available'
                      ? 'text-green-700'
                      : kind === 'swap'
                      ? 'text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide'
                      : 'text-gray-400'
                  return (
                    <button
                      key={room.id}
                      type="button"
                      disabled={!enabled}
                      onClick={() => enabled && setPickerSelectedRoomId(room.id)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 border rounded-lg transition-colors text-left ${
                        isSelected
                          ? 'bg-primary-50 border-primary-400'
                          : enabled
                          ? 'bg-white border-gray-200 hover:bg-gray-50'
                          : 'bg-gray-50 border-gray-200 opacity-60 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex flex-col min-w-0 gap-0.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
                          <span className={`text-sm font-medium truncate ${enabled ? 'text-gray-900' : 'text-gray-500'}`}>
                            #{room.roomNumber}
                            {room.floor ? ` (Floor ${room.floor})` : ''}
                          </span>
                          <span className="text-xs text-gray-400 truncate">
                            &middot; {room.roomTypeName}
                          </span>
                        </div>
                        {kind === 'swap' && (
                          <span className="text-[11px] text-gray-500 ml-4 truncate">
                            Currently {partnerLabel(cand.partner)} &middot;{' '}
                            {cand.partner.checkIn} &rarr; {cand.partner.checkOut}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-xs ${badgeStyle}`}>{badgeText}</span>
                        {isSelected && (
                          <svg className="w-4 h-4 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {moveError && (
              <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {moveError}
              </div>
            )}

            <div className="mt-5 pt-4 border-t border-gray-200">
              <button
                onClick={handlePickerContinue}
                disabled={!selectedCandidate || movingRoom}
                className="w-full px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {movingRoom
                  ? 'Moving...'
                  : !selectedCandidate
                  ? 'Select a room to continue'
                  : selectedCandidate.kind === 'swap'
                  ? `Review swap with ${partnerLabel(selectedCandidate.partner)}`
                  : `Move to #${selectedCandidate.room.roomNumber || ''}`}
              </button>
              <p className="mt-2 text-xs text-gray-500 text-center">
                The original confirmation number and payment record are preserved.
              </p>
            </div>
          </div>
        ) : view === 'swapConfirm' && pendingSwap ? (
          /* ── SWAP CONFIRM ── */
          <div className="p-6">
            <div className="flex items-center gap-3 mb-1">
              <button
                onClick={() => setView('roomPicker')}
                aria-label="Back"
                className="text-gray-500 hover:text-gray-800 -ml-1 p-1 rounded hover:bg-gray-100 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <h2 className="text-lg font-bold text-gray-900">Confirm room swap</h2>
            </div>
            <p className="text-sm text-gray-500 mb-4 ml-8">
              Both bookings keep their confirmation numbers, payment records, and guest history.
            </p>

            {(() => {
              const sourceFromRoom = currentRoom
              const sourceToRoom = rooms.find((r) => r.id === pendingSwap.sourceDestinationRoomId) || null
              const partnerFromRoom = rooms.find((r) => r.id === pendingSwap.partnerCurrentRoomId) || null
              const partnerToRoom = rooms.find((r) => r.id === pendingSwap.partnerDestinationRoomId) || null
              const Card = ({
                title, dates, fromRoom, toRoom,
              }: {
                title: string
                dates: string
                fromRoom: typeof rooms[number] | null
                toRoom: typeof rooms[number] | null
              }) => (
                <div className="border border-gray-200 rounded-lg p-3">
                  <p className="text-sm font-semibold text-gray-900 truncate">{title}</p>
                  <p className="text-xs text-gray-500 mb-2">{dates}</p>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-gray-600">
                      {fromRoom ? `#${fromRoom.roomNumber}` : 'Unassigned'}
                    </span>
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                    <span className="font-semibold text-gray-900">
                      {toRoom ? `#${toRoom.roomNumber}` : '—'}
                    </span>
                  </div>
                </div>
              )
              return (
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <Card
                    title={`${booking.guestFirstName} ${booking.guestLastName}`}
                    dates={`${booking.checkIn} → ${booking.checkOut}`}
                    fromRoom={sourceFromRoom}
                    toRoom={sourceToRoom}
                  />
                  <Card
                    title={pendingSwap.partnerBookingLabel}
                    dates={`${pendingSwap.partnerCheckIn} → ${pendingSwap.partnerCheckOut}`}
                    fromRoom={partnerFromRoom}
                    toRoom={partnerToRoom}
                  />
                </div>
              )
            })()}

            {moveError && (
              <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {moveError}
              </div>
            )}

            <div className="flex gap-2 mt-5 pt-4 border-t border-gray-200">
              <button
                onClick={() => setView('roomPicker')}
                disabled={movingRoom}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
              >
                Back
              </button>
              <button
                onClick={handleConfirmSwap}
                disabled={movingRoom}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50"
              >
                {movingRoom ? 'Swapping…' : 'Confirm swap'}
              </button>
            </div>
          </div>
        ) : view === 'moveSuccess' ? (
          /* ── MOVE SUCCESS ── */
          <div className="p-8 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-900">
              Reservation moved &mdash; {booking.guestFirstName} {booking.guestLastName} is now in #{movedToRoomNumber}
            </p>
          </div>
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
                {/* Move-to-another-room — assigned bookings get the standard
                    flow; unassigned bookings open the picker too so they can
                    pick a free room or trigger a swap when none is free. */}
                {booking.status !== 'cancelled' && (
                  <button
                    onClick={enterRoomPicker}
                    className="w-full px-4 py-2 text-sm font-medium text-primary-700 border border-primary-300 hover:bg-primary-50 rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    {booking.roomId ? 'Move to another room' : 'Assign room'}
                  </button>
                )}
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
