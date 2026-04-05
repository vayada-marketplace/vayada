'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { roomsService, RoomType } from '@/services/rooms'
import { bookingsService, Booking } from '@/services/bookings'
import { formatCurrency } from '@/lib/formatCurrency'
import { getCurrencySymbol } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'

function getToday() {
  return new Date().toISOString().split('T')[0]
}

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500',
  'bg-orange-500', 'bg-pink-500', 'bg-teal-500',
  'bg-rose-500', 'bg-amber-500',
]

function getAvatarColor(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function getInitials(first: string, last: string) {
  return `${first[0] || ''}${last[0] || ''}`.toUpperCase()
}

export default function DashboardPage() {
  const { t } = useTranslation()
  const [rooms, setRooms] = useState<RoomType[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [hotelCurrency, setHotelCurrency] = useState('EUR')
  const [loading, setLoading] = useState(true)

  const today = getToday()

  useEffect(() => {
    Promise.all([
      roomsService.list(),
      bookingsService.list({ status: 'confirmed', limit: 500 }),
      bookingsService.getPaymentSettings(),
    ])
      .then(([roomsList, bookingsRes, settingsRes]) => {
        setRooms(roomsList)
        setBookings(bookingsRes.bookings)
        setHotelCurrency(settingsRes.paymentSettings.defaultCurrency || 'EUR')
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const totalRooms = useMemo(
    () => rooms.reduce((sum, r) => sum + r.totalRooms, 0),
    [rooms]
  )

  const arrivalsToday = useMemo(
    () => bookings.filter(b => b.checkIn === today),
    [bookings, today]
  )

  const departuresToday = useMemo(
    () => bookings.filter(b => b.checkOut === today),
    [bookings, today]
  )

  const occupiedTonight = useMemo(
    () => bookings.filter(b => b.checkIn <= today && b.checkOut > today).length,
    [bookings, today]
  )

  const occupancyPct = totalRooms > 0 ? Math.round((occupiedTonight / totalRooms) * 100) : 0

  const thirtyDaysAgoStr = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().split('T')[0]
  }, [])

  const revenueThisMonth = useMemo(
    () =>
      bookings
        .filter(b => b.checkIn >= thirtyDaysAgoStr)
        .reduce((sum, b) => sum + b.totalAmount, 0),
    [bookings, thirtyDaysAgoStr]
  )

  const forecastDays = useMemo(() => {
    const days = []
    for (let i = 0; i < 14; i++) {
      const date = new Date()
      date.setDate(date.getDate() + i)
      const dateStr = date.toISOString().split('T')[0]
      const occupied = bookings.filter(b => b.checkIn <= dateStr && b.checkOut > dateStr).length
      const pct = totalRooms > 0 ? Math.round((occupied / totalRooms) * 100) : 0
      days.push({
        date,
        dateStr,
        pct,
        label: i === 0 ? t('common.today') : date.toLocaleDateString('en-US', { weekday: 'short' }),
        dayNum: date.getDate(),
      })
    }
    return days
  }, [bookings, totalRooms])

  if (loading) {
    return (
      <div className="p-4 md:p-6">
        <div className="animate-pulse space-y-4 md:space-y-5">
          <div className="h-8 bg-gray-200 rounded w-40" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-24 md:h-28 bg-gray-200 rounded-xl" />)}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
            <div className="h-56 bg-gray-200 rounded-xl" />
            <div className="h-56 bg-gray-200 rounded-xl" />
          </div>
          <div className="h-52 bg-gray-200 rounded-xl" />
        </div>
      </div>
    )
  }

  const currencySymbol = getCurrencySymbol(bookings[0]?.currency || 'USD')

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Title */}
      <div>
        <h1 className="text-2xl md:text-xl font-bold text-gray-900">{t('dashboard.title')}</h1>
        <p className="text-xs text-gray-400 mt-1 md:mt-0.5">{dateLabel}</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={t('dashboard.occupancyTonight')}
          value={`${occupancyPct}%`}
          sub={t('dashboard.occupancySub', { occupied: String(occupiedTonight), total: String(totalRooms) })}
          icon={<OccupancyIcon />}
        />
        <StatCard
          label={t('dashboard.arrivalsToday')}
          value={String(arrivalsToday.length)}
          sub={
            arrivalsToday[0]
              ? t('dashboard.nextArrival', { guestName: `${arrivalsToday[0].guestFirstName} ${arrivalsToday[0].guestLastName}` })
              : t('dashboard.noArrivals')
          }
          icon={<ArrowDownIcon />}
        />
        <StatCard
          label={t('dashboard.departuresToday')}
          value={String(departuresToday.length)}
          sub={departuresToday.length > 0 ? t('dashboard.firstCheckout') : t('dashboard.noDepartures')}
          icon={<ArrowUpIcon />}
        />
        <StatCard
          label={t('dashboard.revenueThisMonth')}
          value={formatCurrency(revenueThisMonth, hotelCurrency)}
          sub={t('dashboard.last30Days')}
          icon={<DollarIcon />}
        />
      </div>

      {/* Arrivals & Departures */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Arrivals */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">{t('dashboard.arrivalsToday')}</span>
              <span className="inline-flex items-center justify-center w-5 h-5 text-[11px] font-semibold bg-blue-100 text-blue-700 rounded-full">
                {arrivalsToday.length}
              </span>
            </div>
            <Link href="/bookings" className="shrink-0 text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap">
              {t('dashboard.viewAll')} ↗
            </Link>
          </div>
          {arrivalsToday.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">{t('dashboard.noArrivals')}</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {arrivalsToday.map(b => (
                <div key={b.id} className="flex items-center gap-3 py-2.5">
                  <Avatar first={b.guestFirstName} last={b.guestLastName} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {b.guestFirstName} {b.guestLastName}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      <span className="text-gray-500">3:00 PM</span> · {b.roomName}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                    {t('dashboard.confirmed')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Departures */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">{t('dashboard.departuresToday')}</span>
              <span className="inline-flex items-center justify-center w-5 h-5 text-[11px] font-semibold bg-blue-100 text-blue-700 rounded-full">
                {departuresToday.length}
              </span>
            </div>
            <Link href="/bookings" className="shrink-0 text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap">
              {t('dashboard.viewAll')} ↗
            </Link>
          </div>
          {departuresToday.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">{t('dashboard.noDepartures')}</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {departuresToday.map(b => (
                <div key={b.id} className="flex items-center gap-3 py-2.5">
                  <Avatar first={b.guestFirstName} last={b.guestLastName} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {b.guestFirstName} {b.guestLastName}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      <span className="text-gray-500">11:00 AM</span> · {b.roomName}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] font-medium text-green-600">{t('dashboard.settled')} ✓</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Occupancy Forecast */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{t('dashboard.occupancyForecast')}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{t('dashboard.next14Days')}</p>
          </div>
          {forecastDays.length >= 14 && (
            <p className="text-xs text-gray-400">
              {forecastDays[0].date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} –{' '}
              {forecastDays[13].date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </p>
          )}
        </div>
        <ForecastChart days={forecastDays} today={today} />
      </div>
    </div>
  )
}

/* ── Sub-components ── */

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string
  value: string
  sub: string
  icon: React.ReactNode
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3 md:p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-[11px] md:text-xs text-gray-500 leading-tight">{label}</p>
        <div className="w-7 h-7 bg-blue-50 rounded-lg flex items-center justify-center text-blue-500 shrink-0">
          {icon}
        </div>
      </div>
      <p className="text-xl md:text-2xl font-bold text-gray-900 leading-none mb-1.5 truncate">{value}</p>
      <p className="text-[11px] md:text-xs text-gray-400 leading-tight line-clamp-2">{sub}</p>
    </div>
  )
}

function Avatar({ first, last }: { first: string; last: string }) {
  const color = getAvatarColor(first + last)
  const initials = getInitials(first, last)
  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0 ${color}`}
    >
      {initials}
    </div>
  )
}

function ForecastChart({
  days,
  today,
}: {
  days: { date: Date; dateStr: string; pct: number; label: string; dayNum: number }[]
  today: string
}) {
  const maxPct = Math.max(...days.map(d => d.pct), 1)

  return (
    <div className="flex items-end gap-1">
      {days.map(day => {
        const isToday = day.dateStr === today
        const heightPx = Math.max(Math.round((day.pct / maxPct) * 70), 2)
        const isHighOccupancy = day.pct >= 90

        return (
          <div key={day.dateStr} className="flex-1 flex flex-col items-center">
            <span
              className={`text-[10px] font-medium mb-1 ${isToday ? 'text-blue-600' : 'text-gray-500'}`}
            >
              {day.pct}%
            </span>
            <div className="w-full flex items-end" style={{ height: 70 }}>
              <div
                className={`w-full rounded-t-sm ${
                  isHighOccupancy
                    ? 'bg-emerald-500'
                    : isToday
                    ? 'bg-blue-600'
                    : day.pct < 30
                    ? 'bg-blue-200'
                    : 'bg-blue-500'
                }`}
                style={{ height: heightPx }}
              />
            </div>
            <div className="text-center mt-1">
              <p
                className={`text-[10px] font-medium ${isToday ? 'text-blue-600' : 'text-gray-500'}`}
              >
                {day.label}
              </p>
              <p className="text-[9px] text-gray-400">{day.dayNum}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── Icons ── */

function OccupancyIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
      <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
      <path d="M3 7h18" /><path d="M8 11h8" />
    </svg>
  )
}

function ArrowDownIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" /><path d="M19 12l-7 7-7-7" />
    </svg>
  )
}

function ArrowUpIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
    </svg>
  )
}

function DollarIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  )
}
