'use client'

import { useState } from 'react'
import { CalendarRoomType } from '@/services/calendar'

interface BlockModalProps {
  roomTypes: CalendarRoomType[]
  onSubmit: (data: {
    roomTypeId: string
    startDate: string
    endDate: string
    blockedCount: number
    reason: string
  }) => Promise<void>
  onClose: () => void
}

export default function BlockModal({ roomTypes, onSubmit, onClose }: BlockModalProps) {
  const [roomTypeId, setRoomTypeId] = useState(roomTypes[0]?.id || '')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [blockedCount, setBlockedCount] = useState(1)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const selectedRoom = roomTypes.find((rt) => rt.id === roomTypeId)
  const maxRooms = selectedRoom?.totalRooms || 1

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

    setSubmitting(true)
    try {
      await onSubmit({ roomTypeId, startDate, endDate, blockedCount, reason })
    } catch (err: any) {
      setError(err?.message || 'Failed to create block')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-4">Block Rooms</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Room Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Room Type
            </label>
            <select
              value={roomTypeId}
              onChange={(e) => {
                setRoomTypeId(e.target.value)
                setBlockedCount(1)
              }}
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
                onChange={(e) => setStartDate(e.target.value)}
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

          {/* Number of rooms */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Rooms to Block
            </label>
            <input
              type="number"
              min={1}
              max={maxRooms}
              value={blockedCount}
              onChange={(e) => setBlockedCount(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">Max: {maxRooms}</p>
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

          {error && (
            <p className="text-sm text-red-600">{error}</p>
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
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? 'Blocking...' : 'Block Rooms'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
