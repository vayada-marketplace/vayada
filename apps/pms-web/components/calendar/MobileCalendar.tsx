'use client'

import { useState, useMemo } from 'react'
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  addMonths,
  isSameMonth,
  isSameDay,
  parseISO,
  isWithinInterval,
} from 'date-fns'
import { CalendarBooking } from '@/services/calendar'

const CHANNEL_COLORS: Record<string, string> = {
  direct: 'bg-blue-500',
  airbnb: 'bg-pink-500',
  'booking.com': 'bg-indigo-500',
  expedia: 'bg-yellow-500',
  other: 'bg-gray-400',
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

interface MobileCalendarProps {
  bookings: CalendarBooking[]
  onSelectBooking: (id: string) => void
  onNewBooking: () => void
}

export default function MobileCalendar({ bookings, onSelectBooking, onNewBooking }: MobileCalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date())

  const monthStart = startOfMonth(currentMonth)
  const monthEnd = endOfMonth(currentMonth)
  const calStart = startOfWeek(monthStart, { weekStartsOn: 1 })
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 })

  // Build array of calendar days
  const days = useMemo(() => {
    const result: Date[] = []
    let day = calStart
    while (day <= calEnd) {
      result.push(day)
      day = addDays(day, 1)
    }
    return result
  }, [currentMonth])

  // Map each day to its bookings
  const bookingsByDay = useMemo(() => {
    const map: Record<string, CalendarBooking[]> = {}
    for (const b of bookings) {
      const start = parseISO(b.checkIn)
      const end = addDays(parseISO(b.checkOut), -1) // checkOut is departure day
      for (const day of days) {
        if (isWithinInterval(day, { start, end })) {
          const key = format(day, 'yyyy-MM-dd')
          if (!map[key]) map[key] = []
          if (!map[key].find(x => x.id === b.id)) {
            map[key].push(b)
          }
        }
      }
    }
    return map
  }, [bookings, days])

  const selectedDayBookings = useMemo(() => {
    if (!selectedDate) return []
    return bookingsByDay[format(selectedDate, 'yyyy-MM-dd')] || []
  }, [selectedDate, bookingsByDay])

  const today = new Date()

  return (
    <div className="flex flex-col h-full">
      {/* Month header */}
      <div className="bg-white border-b border-gray-200 px-4 pt-3 pb-2">
        <div className="text-center text-[11px] text-gray-400 mb-1">{format(currentMonth, 'yyyy')}</div>
        <div className="flex items-center justify-between">
          <button
            onClick={() => setCurrentMonth(m => addMonths(m, -1))}
            className="p-1.5 text-gray-500 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h2 className="text-[15px] font-bold text-gray-900">{format(currentMonth, 'MMMM')}</h2>
          <button
            onClick={() => setCurrentMonth(m => addMonths(m, 1))}
            className="p-1.5 text-gray-500 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="bg-white px-3 py-2">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 mb-1">
          {WEEKDAYS.map(d => (
            <div key={d} className="text-center text-[10px] font-medium text-gray-400 py-1">{d}</div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {days.map(day => {
            const key = format(day, 'yyyy-MM-dd')
            const dayBookings = bookingsByDay[key] || []
            const isCurrentMonth = isSameMonth(day, currentMonth)
            const isToday = isSameDay(day, today)
            const isSelected = selectedDate && isSameDay(day, selectedDate)
            const hasBookings = dayBookings.length > 0

            // Get unique channel colors for dots
            const channels = Array.from(new Set(dayBookings.map(b => b.channel)))

            return (
              <button
                key={key}
                onClick={() => setSelectedDate(day)}
                className={`relative flex flex-col items-center py-1.5 rounded-xl transition-colors ${
                  isSelected
                    ? 'bg-primary-500 text-white'
                    : isToday
                      ? 'bg-gray-100 text-gray-900'
                      : isCurrentMonth
                        ? 'text-gray-900'
                        : 'text-gray-300'
                }`}
              >
                <span className={`text-[13px] font-medium ${isSelected ? 'font-bold' : ''}`}>
                  {format(day, 'd')}
                </span>
                {/* Booking dots */}
                {hasBookings && !isSelected && (
                  <div className="flex gap-0.5 mt-0.5">
                    {channels.slice(0, 3).map(ch => (
                      <div key={ch} className={`w-1 h-1 rounded-full ${CHANNEL_COLORS[ch] || CHANNEL_COLORS.other}`} />
                    ))}
                  </div>
                )}
                {hasBookings && isSelected && (
                  <div className="flex gap-0.5 mt-0.5">
                    {channels.slice(0, 3).map(ch => (
                      <div key={ch} className="w-1 h-1 rounded-full bg-white/60" />
                    ))}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Selected day bookings */}
      <div className="flex-1 bg-gray-50 overflow-auto">
        <div className="px-3 py-2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[12px] font-semibold text-gray-700">
              {selectedDate ? format(selectedDate, 'EEEE, MMM d') : 'Select a day'}
            </h3>
            <button
              onClick={onNewBooking}
              className="px-2.5 py-1 text-[11px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
            >
              + New
            </button>
          </div>

          {selectedDayBookings.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
              <p className="text-[12px] text-gray-400">No bookings on this day</p>
            </div>
          ) : (
            <div className="space-y-2">
              {selectedDayBookings.map(b => {
                const channelColor = CHANNEL_COLORS[b.channel] || CHANNEL_COLORS.other
                return (
                  <button
                    key={b.id}
                    onClick={() => onSelectBooking(b.id)}
                    className="w-full bg-white rounded-lg border border-gray-200 p-3 text-left hover:border-gray-300 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className={`w-8 h-8 rounded-full ${channelColor} flex items-center justify-center text-white text-[10px] font-bold shrink-0`}>
                        {b.guestFirstName.charAt(0)}{b.guestLastName.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-gray-900 truncate">
                          {b.guestFirstName} {b.guestLastName}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          {b.checkIn} → {b.checkOut}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-medium ${
                          b.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                          b.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {b.status}
                        </span>
                        <div className="text-[10px] text-gray-400 mt-0.5 capitalize">{b.channel}</div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
