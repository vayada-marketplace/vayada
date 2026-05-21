'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { useTranslation } from '@/lib/i18n'

interface MiniDatePickerProps {
  value: Date
  onChange: (d: Date) => void
  onClose: () => void
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export default function MiniDatePicker({ value, onChange, onClose }: MiniDatePickerProps) {
  const { t } = useTranslation()
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(value))
  const containerRef = useRef<HTMLDivElement | null>(null)
  const today = useMemo(() => startOfDay(new Date()), [])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Build week rows for the visible month, skipping any week that contains no
  // day belonging to viewMonth. This handles the edge cases where a month
  // starts on Sunday (no leading empty cells) or has fewer than 6 weeks (no
  // trailing empty row).
  const weeks = useMemo(() => {
    const monthStart = startOfMonth(viewMonth)
    const monthEnd = endOfMonth(viewMonth)
    const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 })
    const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 })
    const rows: Date[][] = []
    let cursor = gridStart
    while (cursor <= gridEnd) {
      const week: Date[] = []
      for (let i = 0; i < 7; i++) {
        week.push(cursor)
        cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
      }
      if (week.some((d) => isSameMonth(d, viewMonth))) rows.push(week)
    }
    return rows
  }, [viewMonth])

  const goPrev = () => setViewMonth((m) => addMonths(m, -1))
  const goNext = () => setViewMonth((m) => addMonths(m, 1))
  const pick = (d: Date) => {
    onChange(startOfDay(d))
    onClose()
  }
  const jumpToToday = () => {
    onChange(today)
    onClose()
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={t('calendar.openDatePicker')}
      className="absolute left-0 top-full mt-2 z-30 w-72 bg-white border border-gray-200 shadow-xl rounded-xl p-3"
    >
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={goPrev}
          aria-label={t('calendar.prevMonth')}
          className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="text-sm font-semibold text-gray-900">
          {format(viewMonth, 'MMMM yyyy')}
        </div>
        <button
          type="button"
          onClick={goNext}
          aria-label={t('calendar.nextMonth')}
          className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {WEEKDAY_LABELS.map((d, i) => (
          <div key={i} className="text-center text-[10px] font-medium text-gray-400 py-1">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {weeks.flat().map((d, i) => {
          const inMonth = isSameMonth(d, viewMonth)
          const isToday = isSameDay(d, today)
          const isSelected = isSameDay(d, value)
          const dow = d.getDay()
          const isWeekend = dow === 0 || dow === 6
          let cls = 'flex items-center justify-center w-9 h-9 text-[13px] rounded-full transition-colors'
          if (!inMonth) {
            cls += ' text-gray-300 hover:bg-gray-50'
          } else if (isToday) {
            cls += ' bg-primary-500 text-white font-semibold hover:bg-primary-600'
          } else if (isSelected) {
            cls += ' ring-2 ring-primary-500 text-gray-900 hover:bg-gray-100'
          } else if (isWeekend) {
            cls += ' text-gray-400 hover:bg-gray-100'
          } else {
            cls += ' text-gray-900 hover:bg-gray-100'
          }
          return (
            <button
              key={i}
              type="button"
              onClick={() => pick(d)}
              className={cls}
            >
              {format(d, 'd')}
            </button>
          )
        })}
      </div>

      <div className="mt-2 pt-2 border-t border-gray-100 text-center">
        <button
          type="button"
          onClick={jumpToToday}
          className="text-xs font-medium text-primary-600 hover:text-primary-700 hover:underline"
        >
          {t('calendar.jumpToToday')}
        </button>
      </div>
    </div>
  )
}
