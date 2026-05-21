'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarBooking, CalendarRoom, CalendarRoomType } from '@/services/calendar'
import Modal from '@/components/Modal'

// Returns the YYYY-MM-DD string one day after the given YYYY-MM-DD string.
// Parsed as local date so DST / timezone doesn't shift the result.
function addOneDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return ''
  const next = new Date(y, m - 1, d + 1)
  const yyyy = next.getFullYear()
  const mm = String(next.getMonth() + 1).padStart(2, '0')
  const dd = String(next.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

interface BlockModalProps {
  roomTypes: CalendarRoomType[]
  rooms: CalendarRoom[]
  bookings: CalendarBooking[]
  onSubmit: (data: {
    roomTypeId: string
    roomIds: string[]
    startDate: string
    endDate: string
    reason: string
  }) => Promise<void>
  onClose: () => void
  initialRoomTypeId?: string
  initialRoomId?: string
  initialStartDate?: string
  initialEndDate?: string
}

export default function BlockModal({
  roomTypes,
  rooms,
  bookings,
  onSubmit,
  onClose,
  initialRoomTypeId,
  initialRoomId,
  initialStartDate,
  initialEndDate,
}: BlockModalProps) {
  const [roomTypeId, setRoomTypeId] = useState(initialRoomTypeId || roomTypes[0]?.id || '')
  const [startDate, setStartDate] = useState(initialStartDate || '')
  const [endDate, setEndDate] = useState(initialEndDate || '')
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>(
    initialRoomId ? [initialRoomId] : []
  )
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [confirmOverlap, setConfirmOverlap] = useState(false)

  const roomsForType = useMemo(
    () => rooms.filter((r) => r.roomTypeId === roomTypeId),
    [rooms, roomTypeId]
  )

  // Bookings assigned to a selected room whose stay overlaps the block range.
  // Both ranges are half-open [start, end): they overlap iff start < otherEnd
  // && otherStart < end. ISO YYYY-MM-DD strings compare correctly as strings.
  const overlappingBookings = useMemo(() => {
    if (!startDate || !endDate || selectedRoomIds.length === 0) return []
    return bookings.filter(
      (b) =>
        b.roomId != null &&
        selectedRoomIds.includes(b.roomId) &&
        b.checkIn < endDate &&
        b.checkOut > startDate
    )
  }, [bookings, startDate, endDate, selectedRoomIds])

  // Re-arm the warning whenever the range or room selection changes, so a user
  // who edits the dates after seeing it can't skip a fresh overlap.
  useEffect(() => {
    setConfirmOverlap(false)
  }, [startDate, endDate, selectedRoomIds])

  const allSelected =
    roomsForType.length > 0 && selectedRoomIds.length === roomsForType.length

  const toggleRoom = (id: string) => {
    setSelectedRoomIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const toggleAll = () => {
    setSelectedRoomIds(allSelected ? [] : roomsForType.map((r) => r.id))
  }

  const handleRoomTypeChange = (newId: string) => {
    setRoomTypeId(newId)
    setSelectedRoomIds([])
  }

  const handleStartDateChange = (newStart: string) => {
    setStartDate(newStart)
    if (newStart && (!endDate || endDate <= newStart)) {
      setEndDate(addOneDay(newStart))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!startDate || !endDate) {
      setError('Please select both start and end dates')
      return
    }
    if (endDate <= startDate) {
      setError('End date must be after start date')
      return
    }
    if (selectedRoomIds.length === 0) {
      setError('Please select at least one room to block')
      return
    }
    // Don't silently block over a booking — make the user confirm once.
    if (overlappingBookings.length > 0 && !confirmOverlap) {
      setConfirmOverlap(true)
      return
    }

    setSubmitting(true)
    try {
      await onSubmit({ roomTypeId, roomIds: selectedRoomIds, startDate, endDate, reason })
    } catch (err: any) {
      setError(err?.message || 'Failed to create block')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold text-gray-900 mb-4">Block Rooms</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Room Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Room Type
          </label>
          <select
            value={roomTypeId}
            onChange={(e) => handleRoomTypeChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          >
            {roomTypes.map((rt) => (
              <option key={rt.id} value={rt.id}>
                {rt.name} ({rt.totalRooms} rooms)
              </option>
            ))}
          </select>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => handleStartDateChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              End Date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              required
            />
          </div>
        </div>

        {/* Rooms */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700">
              Rooms to Block
            </label>
            {roomsForType.length > 0 && (
              <button
                type="button"
                onClick={toggleAll}
                className="text-xs text-primary-600 hover:text-primary-700 font-medium"
              >
                {allSelected ? 'Clear all' : 'Select all'}
              </button>
            )}
          </div>
          {roomsForType.length === 0 ? (
            <p className="text-xs text-gray-500 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
              No rooms configured for this room type.
            </p>
          ) : (
            <div className="max-h-48 overflow-y-auto border border-gray-300 rounded-lg divide-y divide-gray-100">
              {roomsForType.map((r) => {
                const checked = selectedRoomIds.includes(r.id)
                return (
                  <label
                    key={r.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRoom(r.id)}
                      className="w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                    />
                    <span className="font-medium text-gray-900">#{r.roomNumber}</span>
                    {r.floor && (
                      <span className="text-xs text-gray-500">Floor {r.floor}</span>
                    )}
                  </label>
                )
              })}
            </div>
          )}
          <p className="text-xs text-gray-500 mt-1">
            {selectedRoomIds.length} of {roomsForType.length} selected
          </p>
        </div>

        {/* Reason */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Reason
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Maintenance, Renovation"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {confirmOverlap && overlappingBookings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <p className="font-medium">This block overlaps existing bookings:</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {overlappingBookings.slice(0, 5).map((b) => (
                <li key={`${b.id}-${b.roomId}`}>
                  {b.guestFirstName} {b.guestLastName}
                  {b.roomNumber ? ` · #${b.roomNumber}` : ''} · {b.checkIn} → {b.checkOut}
                </li>
              ))}
              {overlappingBookings.length > 5 && (
                <li>+{overlappingBookings.length - 5} more</li>
              )}
            </ul>
            <p className="mt-1.5">Continue anyway?</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || selectedRoomIds.length === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50"
          >
            {submitting
              ? 'Blocking...'
              : confirmOverlap && overlappingBookings.length > 0
                ? 'Block anyway'
                : 'Block Rooms'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
