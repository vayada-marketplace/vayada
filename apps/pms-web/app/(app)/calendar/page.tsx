'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { format, addDays, startOfDay, differenceInDays, parseISO } from 'date-fns'
import {
  calendarService,
  CalendarData,
  CalendarBooking,
  CalendarBlock,
  CalendarRoom,
  CreateAdminBookingPayload,
} from '@/services/calendar'
import BlockModal from '@/components/calendar/BlockModal'
import NewBookingModal from '@/components/calendar/NewBookingModal'
import BookingDetailModal from '@/components/calendar/BookingDetailModal'

const VIEW_DAYS = 21

const CHANNEL_COLORS: Record<string, string> = {
  direct: 'bg-blue-500',
  airbnb: 'bg-pink-500',
  'booking.com': 'bg-indigo-500',
  expedia: 'bg-yellow-500',
  other: 'bg-gray-500',
}

const CHANNEL_LEGEND = [
  { key: 'direct', label: 'Direct', color: 'bg-blue-500' },
  { key: 'airbnb', label: 'Airbnb', color: 'bg-pink-500' },
  { key: 'booking.com', label: 'Booking.com', color: 'bg-indigo-500' },
  { key: 'expedia', label: 'Expedia', color: 'bg-yellow-500' },
  { key: 'other', label: 'Other', color: 'bg-gray-500' },
]

export default function CalendarPage() {
  const [startDate, setStartDate] = useState(() => startOfDay(new Date()))
  const [data, setData] = useState<CalendarData | null>(null)
  const [loading, setLoading] = useState(true)
  const [showBlockModal, setShowBlockModal] = useState(false)
  const [showNewBookingModal, setShowNewBookingModal] = useState(false)
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null)

  const endDate = addDays(startDate, VIEW_DAYS)
  const dates = useMemo(
    () => Array.from({ length: VIEW_DAYS }, (_, i) => addDays(startDate, i)),
    [startDate]
  )

  const fetchData = () => {
    setLoading(true)
    calendarService
      .getCalendarData(format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd'))
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchData()
  }, [startDate])

  const goToday = () => setStartDate(startOfDay(new Date()))
  const goPrev = () => setStartDate((d) => addDays(d, -7))
  const goNext = () => setStartDate((d) => addDays(d, 7))

  const handleCreateBlock = async (blockData: {
    roomTypeId: string
    startDate: string
    endDate: string
    blockedCount: number
    reason: string
  }) => {
    await calendarService.createRoomBlock(blockData)
    setShowBlockModal(false)
    fetchData()
  }

  const handleCreateBooking = async (bookingData: CreateAdminBookingPayload) => {
    await calendarService.createAdminBooking(bookingData)
    setShowNewBookingModal(false)
    fetchData()
  }

  const handleDeleteBlock = async (blockId: string) => {
    await calendarService.deleteRoomBlock(blockId)
    fetchData()
  }

  // Calculate bar position and width relative to the visible date range
  const getBarStyle = (itemStart: string, itemEnd: string) => {
    const s = parseISO(itemStart)
    const e = parseISO(itemEnd)
    const offsetDays = Math.max(0, differenceInDays(s, startDate))
    const endOffset = Math.min(VIEW_DAYS, differenceInDays(e, startDate))
    const spanDays = endOffset - offsetDays
    if (spanDays <= 0) return null
    return {
      left: `${(offsetDays / VIEW_DAYS) * 100}%`,
      width: `${(spanDays / VIEW_DAYS) * 100}%`,
    }
  }

  // Group rooms by room type
  const roomsByType = useMemo(() => {
    if (!data) return {}
    const map: Record<string, CalendarRoom[]> = {}
    for (const r of data.rooms) {
      if (!map[r.roomTypeId]) map[r.roomTypeId] = []
      map[r.roomTypeId].push(r)
    }
    return map
  }, [data])

  // Group bookings by room ID (for assigned bookings) and room type (for unassigned)
  const bookingsByRoom = useMemo(() => {
    if (!data) return {}
    const map: Record<string, CalendarBooking[]> = {}
    for (const b of data.bookings) {
      if (b.roomId) {
        if (!map[b.roomId]) map[b.roomId] = []
        map[b.roomId].push(b)
      }
    }
    return map
  }, [data])

  const unassignedByType = useMemo(() => {
    if (!data) return {}
    const map: Record<string, CalendarBooking[]> = {}
    for (const b of data.bookings) {
      if (!b.roomId) {
        if (!map[b.roomTypeId]) map[b.roomTypeId] = []
        map[b.roomTypeId].push(b)
      }
    }
    return map
  }, [data])

  // Group blocks by room type
  const blocksByRoom = useMemo(() => {
    if (!data) return {}
    const map: Record<string, CalendarBlock[]> = {}
    for (const bl of data.blocks) {
      if (!map[bl.roomTypeId]) map[bl.roomTypeId] = []
      map[bl.roomTypeId].push(bl)
    }
    return map
  }, [data])

  const getInitials = (first: string, last: string) => {
    return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
  }

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Calendar</h1>
          <p className="text-sm text-gray-500">
            {format(startDate, 'MMM d')} &ndash; {format(addDays(endDate, -1), 'MMM d, yyyy')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={goToday}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Today
          </button>
          <button
            onClick={goPrev}
            className="px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            &larr;
          </button>
          <button
            onClick={goNext}
            className="px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            &rarr;
          </button>
          <button
            disabled
            className="ml-2 px-3 py-1.5 text-sm border border-gray-300 rounded-lg text-gray-400 cursor-not-allowed"
          >
            Filter
          </button>
          <button
            disabled
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg text-gray-400 cursor-not-allowed"
          >
            Export
          </button>
          <button
            onClick={() => setShowBlockModal(true)}
            className="px-4 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
          >
            Block Room
          </button>
          <button
            onClick={() => setShowNewBookingModal(true)}
            className="px-4 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
          >
            + New Booking
          </button>
        </div>
      </div>

      {/* Channel Legend */}
      <div className="flex items-center gap-4 mb-4">
        {CHANNEL_LEGEND.map((ch) => (
          <div key={ch.key} className="flex items-center gap-1.5">
            <div className={`w-3 h-3 rounded-sm ${ch.color}`} />
            <span className="text-xs text-gray-600">{ch.label}</span>
          </div>
        ))}
      </div>

      {loading && !data ? (
        <div className="animate-pulse">
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      ) : !data || data.roomTypes.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-gray-500">No room types found. Create room types first.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex-1 overflow-x-auto">
          <table className="w-full min-w-[900px] table-fixed">
            {/* Date header */}
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="w-48 px-3 py-2 text-left text-xs font-medium text-gray-600 sticky left-0 bg-gray-50 z-10 border-r border-gray-200">
                  Room
                </th>
                {dates.map((d) => {
                  const isToday = format(d, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')
                  return (
                    <th
                      key={d.toISOString()}
                      className={`px-0.5 py-2 text-center text-[10px] font-medium border-r border-gray-100 ${
                        isToday ? 'bg-primary-50 text-primary-700' : 'text-gray-500'
                      }`}
                    >
                      <div>{format(d, 'EEE')}</div>
                      <div className="font-semibold text-xs">{format(d, 'd')}</div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {data.roomTypes.map((rt) => {
                const typeRooms = roomsByType[rt.id] || []
                const roomBlocks = blocksByRoom[rt.id] || []
                const unassigned = unassignedByType[rt.id] || []

                return (
                  <React.Fragment key={rt.id}>
                    {/* Room type header row */}
                    <tr className="bg-gray-100/80 border-b border-gray-200">
                      <td className="px-3 py-2 sticky left-0 bg-gray-100/80 z-10 border-r border-gray-200">
                        <div className="text-sm font-semibold text-gray-800">{rt.name}</div>
                        <div className="text-[10px] text-gray-500">
                          {typeRooms.length} room{typeRooms.length !== 1 ? 's' : ''}
                        </div>
                      </td>
                      <td colSpan={VIEW_DAYS} className="relative h-10 p-0">
                        {/* Day grid lines */}
                        <div className="absolute inset-0 flex">
                          {dates.map((d) => (
                            <div key={d.toISOString()} className="flex-1 border-r border-gray-200/50" />
                          ))}
                        </div>
                        {/* Block bars in header row */}
                        {roomBlocks.map((bl) => {
                          const style = getBarStyle(bl.startDate, bl.endDate)
                          if (!style) return null
                          return (
                            <div
                              key={bl.id}
                              className="absolute top-1.5 h-6 rounded px-1.5 text-[10px] font-medium leading-6 truncate z-[1] bg-gray-300 text-gray-700 border border-gray-400 cursor-pointer"
                              style={{
                                ...style,
                                backgroundImage:
                                  'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.08) 3px, rgba(0,0,0,0.08) 6px)',
                              }}
                              title={`Blocked: ${bl.reason || 'No reason'} (${bl.blockedCount} room${bl.blockedCount !== 1 ? 's' : ''})\n${bl.startDate} → ${bl.endDate}\nClick to delete`}
                              onClick={() => {
                                if (confirm(`Delete this block?\n${bl.reason || 'No reason'}\n${bl.startDate} → ${bl.endDate}`)) {
                                  handleDeleteBlock(bl.id)
                                }
                              }}
                            >
                              {bl.reason || 'Blocked'} ({bl.blockedCount})
                            </div>
                          )
                        })}
                      </td>
                    </tr>

                    {/* Individual room rows */}
                    {typeRooms.map((room) => {
                      const roomBookings = bookingsByRoom[room.id] || []
                      return (
                        <tr key={room.id} className="border-b border-gray-100 hover:bg-gray-50/50">
                          <td className="px-3 py-2 sticky left-0 bg-white z-10 border-r border-gray-200">
                            <div className="text-sm font-medium text-gray-900">#{room.roomNumber}</div>
                            <div className="text-[10px] text-gray-400">{room.roomTypeName}</div>
                          </td>
                          <td colSpan={VIEW_DAYS} className="relative h-12 p-0">
                            {/* Day grid lines */}
                            <div className="absolute inset-0 flex">
                              {dates.map((d) => (
                                <div key={d.toISOString()} className="flex-1 border-r border-gray-100" />
                              ))}
                            </div>
                            {/* Booking bars */}
                            {roomBookings.map((b) => {
                              const style = getBarStyle(b.checkIn, b.checkOut)
                              if (!style) return null
                              const channelColor = CHANNEL_COLORS[b.channel] || CHANNEL_COLORS.other
                              return (
                                <div
                                  key={b.id}
                                  className={`absolute top-1.5 h-8 rounded-md px-2 text-[11px] font-medium leading-8 truncate cursor-pointer z-[1] text-white ${channelColor} hover:brightness-110 transition-all flex items-center gap-1.5`}
                                  style={style}
                                  title={`${b.guestFirstName} ${b.guestLastName} (${b.status})\n${b.checkIn} → ${b.checkOut}\nChannel: ${b.channel}`}
                                  onClick={() => setSelectedBookingId(b.id)}
                                >
                                  <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[9px] font-bold flex-shrink-0">
                                    {getInitials(b.guestFirstName, b.guestLastName)}
                                  </span>
                                  <span className="truncate">{b.guestLastName}</span>
                                </div>
                              )
                            })}
                          </td>
                        </tr>
                      )
                    })}

                    {/* Unassigned bookings row (for pre-migration bookings) */}
                    {unassigned.length > 0 && (
                      <tr className="border-b border-gray-100 bg-amber-50/30">
                        <td className="px-3 py-2 sticky left-0 bg-amber-50/30 z-10 border-r border-gray-200">
                          <div className="text-sm font-medium text-amber-700">Unassigned</div>
                          <div className="text-[10px] text-amber-500">{rt.name}</div>
                        </td>
                        <td colSpan={VIEW_DAYS} className="relative h-12 p-0">
                          <div className="absolute inset-0 flex">
                            {dates.map((d) => (
                              <div key={d.toISOString()} className="flex-1 border-r border-gray-100" />
                            ))}
                          </div>
                          {unassigned.map((b) => {
                            const style = getBarStyle(b.checkIn, b.checkOut)
                            if (!style) return null
                            const channelColor = CHANNEL_COLORS[b.channel] || CHANNEL_COLORS.other
                            return (
                              <div
                                key={b.id}
                                className={`absolute top-1.5 h-8 rounded-md px-2 text-[11px] font-medium leading-8 truncate cursor-pointer z-[1] text-white ${channelColor} hover:brightness-110 transition-all flex items-center gap-1.5 opacity-75`}
                                style={style}
                                title={`${b.guestFirstName} ${b.guestLastName} (${b.status}) - Unassigned\n${b.checkIn} → ${b.checkOut}`}
                                onClick={() => setSelectedBookingId(b.id)}
                              >
                                <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[9px] font-bold flex-shrink-0">
                                  {getInitials(b.guestFirstName, b.guestLastName)}
                                </span>
                                <span className="truncate">{b.guestLastName}</span>
                              </div>
                            )
                          })}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Block Modal */}
      {showBlockModal && data && (
        <BlockModal
          roomTypes={data.roomTypes}
          onSubmit={handleCreateBlock}
          onClose={() => setShowBlockModal(false)}
        />
      )}

      {/* New Booking Modal */}
      {showNewBookingModal && data && (
        <NewBookingModal
          roomTypes={data.roomTypes}
          rooms={data.rooms}
          onSubmit={handleCreateBooking}
          onClose={() => setShowNewBookingModal(false)}
        />
      )}

      {/* Booking Detail Modal */}
      {selectedBookingId && (
        <BookingDetailModal
          bookingId={selectedBookingId}
          onClose={() => setSelectedBookingId(null)}
          onStatusChange={fetchData}
        />
      )}
    </div>
  )
}
