'use client'

import { useState, useRef, useEffect } from 'react'

interface DatePickerCalendarProps {
  open: boolean
  onClose: () => void
  checkIn: string | null
  checkOut: string | null
  onSelect: (checkIn: string, checkOut: string) => void
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay()
}

function formatMonthYear(year: number, month: number): string {
  return new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function toDateString(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isSameDay(a: string, b: string): boolean {
  return a === b
}

function isBeforeDate(a: string, b: string): boolean {
  return new Date(a) < new Date(b)
}

function isBetween(date: string, start: string, end: string): boolean {
  const d = new Date(date)
  return d > new Date(start) && d < new Date(end)
}

function isBeforeToday(dateStr: string): boolean {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return new Date(dateStr) < today
}

function getTodayString(): string {
  const t = new Date()
  return toDateString(t.getFullYear(), t.getMonth(), t.getDate())
}

const DAY_LABELS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function MonthGrid({
  year,
  month,
  checkIn,
  checkOut,
  hoverDate,
  onDayClick,
  onDayHover,
}: {
  year: number
  month: number
  checkIn: string | null
  checkOut: string | null
  hoverDate: string | null
  onDayClick: (date: string) => void
  onDayHover: (date: string | null) => void
}) {
  const daysInMonth = getDaysInMonth(year, month)
  const firstDay = getFirstDayOfMonth(year, month)
  const today = getTodayString()

  // Previous month days (grayed out)
  const prevMonth = month === 0 ? 11 : month - 1
  const prevYear = month === 0 ? year - 1 : year
  const daysInPrevMonth = getDaysInMonth(prevYear, prevMonth)

  const cells: { day: number; dateStr: string; isCurrentMonth: boolean }[] = []

  // Fill in previous month trailing days
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = daysInPrevMonth - i
    cells.push({
      day: d,
      dateStr: toDateString(prevYear, prevMonth, d),
      isCurrentMonth: false,
    })
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({
      day: d,
      dateStr: toDateString(year, month, d),
      isCurrentMonth: true,
    })
  }

  // Fill remaining to complete last row
  const remaining = 7 - (cells.length % 7)
  if (remaining < 7) {
    const nextMonth = month === 11 ? 0 : month + 1
    const nextYear = month === 11 ? year + 1 : year
    for (let d = 1; d <= remaining; d++) {
      cells.push({
        day: d,
        dateStr: toDateString(nextYear, nextMonth, d),
        isCurrentMonth: false,
      })
    }
  }

  // Determine the effective end for range highlight (hover preview or checkOut)
  const rangeEnd = checkIn && !checkOut && hoverDate ? hoverDate : checkOut

  return (
    <div>
      {/* Month title */}
      <h3 className="text-sm font-semibold text-gray-900 text-center mb-3">
        {formatMonthYear(year, month)}
      </h3>

      {/* Day labels */}
      <div className="grid grid-cols-7 mb-1">
        {DAY_LABELS.map((label) => (
          <div key={label} className="text-center text-xs font-medium text-gray-400 py-1">
            {label}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {cells.map((cell, idx) => {
          const isPast = isBeforeToday(cell.dateStr) && !isSameDay(cell.dateStr, today)
          const isToday = isSameDay(cell.dateStr, today)
          const isCheckIn = checkIn ? isSameDay(cell.dateStr, checkIn) : false
          const isCheckOut = checkOut ? isSameDay(cell.dateStr, checkOut) : false
          const isSelected = isCheckIn || isCheckOut
          const isInRange =
            checkIn && rangeEnd && !isBeforeDate(rangeEnd, checkIn)
              ? isBetween(cell.dateStr, checkIn, rangeEnd)
              : false
          const isDisabled = isPast || !cell.isCurrentMonth

          return (
            <div
              key={idx}
              className={`relative flex items-center justify-center ${
                isInRange && cell.isCurrentMonth ? 'bg-primary-50' : ''
              } ${isCheckIn && cell.isCurrentMonth ? 'rounded-l-full bg-primary-50' : ''} ${
                (isCheckOut || (checkIn && !checkOut && hoverDate && isSameDay(cell.dateStr, hoverDate))) && cell.isCurrentMonth
                  ? 'rounded-r-full bg-primary-50'
                  : ''
              }`}
            >
              <button
                disabled={isDisabled}
                onClick={() => !isDisabled && onDayClick(cell.dateStr)}
                onMouseEnter={() => !isDisabled && cell.isCurrentMonth && onDayHover(cell.dateStr)}
                onMouseLeave={() => onDayHover(null)}
                className={`w-9 h-9 flex items-center justify-center text-sm rounded-full transition-colors relative z-10 ${
                  isDisabled
                    ? 'text-gray-300 cursor-default'
                    : isSelected && cell.isCurrentMonth
                    ? 'bg-primary-600 text-white font-bold'
                    : isToday && cell.isCurrentMonth
                    ? 'border-2 border-primary-400 text-primary-700 font-semibold'
                    : cell.isCurrentMonth
                    ? 'text-gray-800 hover:bg-primary-100 cursor-pointer font-medium'
                    : 'text-gray-300 cursor-default'
                }`}
              >
                {cell.day}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function DatePickerCalendar({
  open,
  onClose,
  checkIn,
  checkOut,
  onSelect,
}: DatePickerCalendarProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [hoverDate, setHoverDate] = useState<string | null>(null)
  const [selectionState, setSelectionState] = useState<'selectCheckIn' | 'selectCheckOut'>(
    checkIn ? 'selectCheckOut' : 'selectCheckIn'
  )
  const [tempCheckIn, setTempCheckIn] = useState<string | null>(checkIn)
  const [tempCheckOut, setTempCheckOut] = useState<string | null>(checkOut)

  // Calendar months
  const now = new Date()
  const [baseMonth, setBaseMonth] = useState(now.getMonth())
  const [baseYear, setBaseYear] = useState(now.getFullYear())

  const secondMonth = baseMonth === 11 ? 0 : baseMonth + 1
  const secondYear = baseMonth === 11 ? baseYear + 1 : baseYear

  // Reset temp state when opening
  useEffect(() => {
    if (open) {
      setTempCheckIn(checkIn)
      setTempCheckOut(checkOut)
      setSelectionState(checkIn && checkOut ? 'selectCheckIn' : checkIn ? 'selectCheckOut' : 'selectCheckIn')
    }
  }, [open, checkIn, checkOut])

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  if (!open) return null

  const handleDayClick = (date: string) => {
    if (selectionState === 'selectCheckIn') {
      setTempCheckIn(date)
      setTempCheckOut(null)
      setSelectionState('selectCheckOut')
    } else {
      // If clicked date is before check-in, restart selection
      if (tempCheckIn && isBeforeDate(date, tempCheckIn)) {
        setTempCheckIn(date)
        setTempCheckOut(null)
        setSelectionState('selectCheckOut')
      } else {
        setTempCheckOut(date)
        if (tempCheckIn) {
          onSelect(tempCheckIn, date)
          onClose()
        }
      }
    }
  }

  const handlePrev = () => {
    if (baseMonth === 0) {
      setBaseMonth(11)
      setBaseYear(baseYear - 1)
    } else {
      setBaseMonth(baseMonth - 1)
    }
  }

  const handleNext = () => {
    if (baseMonth === 11) {
      setBaseMonth(0)
      setBaseYear(baseYear + 1)
    } else {
      setBaseMonth(baseMonth + 1)
    }
  }

  // Calculate nights for summary
  const nights =
    tempCheckIn && tempCheckOut
      ? Math.ceil((new Date(tempCheckOut).getTime() - new Date(tempCheckIn).getTime()) / (1000 * 60 * 60 * 24))
      : 0

  const formatSummaryDate = (dateStr: string) => {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-3 bg-white rounded-2xl shadow-2xl border border-gray-100 p-6 z-50 w-[640px]"
    >
      {/* Header */}
      <div className="mb-4">
        <h3 className="text-base font-bold text-gray-900">Select your dates</h3>
        <p className="text-sm text-gray-500">Prices shown are starting rates per night</p>
      </div>

      {/* Navigation + Calendars */}
      <div className="flex items-start gap-6">
        {/* Prev button */}
        <button
          onClick={handlePrev}
          className="mt-1 p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Two month grids */}
        <div className="flex-1 grid grid-cols-2 gap-6">
          <MonthGrid
            year={baseYear}
            month={baseMonth}
            checkIn={tempCheckIn}
            checkOut={tempCheckOut}
            hoverDate={selectionState === 'selectCheckOut' ? hoverDate : null}
            onDayClick={handleDayClick}
            onDayHover={setHoverDate}
          />
          <MonthGrid
            year={secondYear}
            month={secondMonth}
            checkIn={tempCheckIn}
            checkOut={tempCheckOut}
            hoverDate={selectionState === 'selectCheckOut' ? hoverDate : null}
            onDayClick={handleDayClick}
            onDayHover={setHoverDate}
          />
        </div>

        {/* Next button */}
        <button
          onClick={handleNext}
          className="mt-1 p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Summary bar */}
      {tempCheckIn && (
        <div className="mt-5 pt-4 border-t border-gray-100 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Your Stay</p>
            <p className="text-sm font-semibold text-gray-900">
              {formatSummaryDate(tempCheckIn)}
              {tempCheckOut && ` — ${formatSummaryDate(tempCheckOut)}`}
            </p>
            {nights > 0 && <p className="text-xs text-gray-500">{nights} night{nights !== 1 ? 's' : ''}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
