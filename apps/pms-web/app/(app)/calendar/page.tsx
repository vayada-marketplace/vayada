'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { format, addDays, startOfDay, differenceInDays, parseISO } from 'date-fns'
import {
  calendarService,
  CalendarData,
  CalendarBooking,
  CalendarBlock,
} from '@/services/calendar'
import BlockModal from '@/components/calendar/BlockModal'

const VIEW_DAYS = 21

export default function CalendarPage() {
  const router = useRouter()
  const [startDate, setStartDate] = useState(() => startOfDay(new Date()))
  const [data, setData] = useState<CalendarData | null>(null)
  const [loading, setLoading] = useState(true)
  const [showBlockModal, setShowBlockModal] = useState(false)

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

  // Group bookings & blocks by room type
  const bookingsByRoom = useMemo(() => {
    if (!data) return {}
    const map: Record<string, CalendarBooking[]> = {}
    for (const b of data.bookings) {
      if (!map[b.roomTypeId]) map[b.roomTypeId] = []
      map[b.roomTypeId].push(b)
    }
    return map
  }, [data])

  const blocksByRoom = useMemo(() => {
    if (!data) return {}
    const map: Record<string, CalendarBlock[]> = {}
    for (const bl of data.blocks) {
      if (!map[bl.roomTypeId]) map[bl.roomTypeId] = []
      map[bl.roomTypeId].push(bl)
    }
    return map
  }, [data])

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">Calendar</h1>
          <span className="text-sm text-gray-500">
            {format(startDate, 'MMM d')} &ndash; {format(addDays(endDate, -1), 'MMM d, yyyy')}
          </span>
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
            onClick={() => setShowBlockModal(true)}
            className="ml-2 px-4 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
          >
            Block Room
          </button>
        </div>
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
                <th className="w-40 px-3 py-2 text-left text-xs font-medium text-gray-600 sticky left-0 bg-gray-50 z-10 border-r border-gray-200">
                  Room Type
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
                const roomBookings = bookingsByRoom[rt.id] || []
                const roomBlocks = blocksByRoom[rt.id] || []
                return (
                  <tr key={rt.id} className="border-b border-gray-100 hover:bg-gray-50/50">
                    <td className="px-3 py-3 sticky left-0 bg-white z-10 border-r border-gray-200">
                      <div className="text-sm font-medium text-gray-900">{rt.name}</div>
                      <div className="text-[10px] text-gray-400">{rt.totalRooms} room{rt.totalRooms !== 1 ? 's' : ''}</div>
                    </td>
                    <td colSpan={VIEW_DAYS} className="relative h-14 p-0">
                      {/* Day grid lines */}
                      <div className="absolute inset-0 flex">
                        {dates.map((d) => (
                          <div
                            key={d.toISOString()}
                            className="flex-1 border-r border-gray-100"
                          />
                        ))}
                      </div>

                      {/* Booking bars */}
                      {roomBookings.map((b) => {
                        const style = getBarStyle(b.checkIn, b.checkOut)
                        if (!style) return null
                        const isConfirmed = b.status === 'confirmed'
                        return (
                          <div
                            key={b.id}
                            className={`absolute top-1 h-5 rounded px-1.5 text-[10px] font-medium leading-5 truncate cursor-pointer z-[1] ${
                              isConfirmed
                                ? 'bg-green-100 text-green-800 border border-green-200'
                                : 'bg-amber-100 text-amber-800 border border-amber-200'
                            }`}
                            style={style}
                            title={`${b.guestFirstName} ${b.guestLastName} (${b.status})\n${b.checkIn} → ${b.checkOut}`}
                            onClick={() => router.push(`/bookings/${b.id}`)}
                          >
                            {b.guestFirstName} {b.guestLastName}
                          </div>
                        )
                      })}

                      {/* Block bars */}
                      {roomBlocks.map((bl) => {
                        const style = getBarStyle(bl.startDate, bl.endDate)
                        if (!style) return null
                        return (
                          <div
                            key={bl.id}
                            className="absolute bottom-1 h-5 rounded px-1.5 text-[10px] font-medium leading-5 truncate z-[1] bg-gray-200 text-gray-600 border border-gray-300"
                            style={{
                              ...style,
                              backgroundImage:
                                'repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 6px)',
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
    </div>
  )
}
