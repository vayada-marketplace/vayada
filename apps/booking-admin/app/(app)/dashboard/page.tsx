'use client'

import { useEffect, useState, useCallback } from 'react'
import { settingsService, type PropertySettings } from '@/services/settings'
import {
  dashboardService,
  type DashboardStats,
  type BookingsBySource,
  type ConversionFunnel,
  type Sparklines,
  type TimeRange,
} from '@/services/dashboard'

const SOURCE_COLORS: Record<string, string> = {
  direct: '#1e3a5f',
  'booking.com': '#3b82f6',
  airbnb: '#93c5fd',
  expedia: '#f59e0b',
  google: '#10b981',
}

const SOURCE_LABELS: Record<string, string> = {
  direct: 'Direct (vayada)',
  'booking.com': 'Booking.com',
  airbnb: 'Airbnb',
  expedia: 'Expedia',
  google: 'Google Hotels',
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value)
}

function formatDiff(current: number, previous: number, isCurrency = false): { text: string; positive: boolean | null } {
  const diff = current - previous
  if (diff === 0 && current === 0) return { text: 'No data yet', positive: null }
  if (diff === 0) return { text: 'Same as previous period', positive: null }
  const formatted = isCurrency ? formatCurrency(Math.abs(diff)) : Math.abs(diff).toString()
  if (diff > 0) return { text: `\u2191 +${formatted} vs previous`, positive: true }
  return { text: `\u2193 -${formatted} vs previous`, positive: false }
}

export default function DashboardPage() {
  const [propertyName, setPropertyName] = useState('')
  const [slug, setSlug] = useState('')
  const [timeRange, setTimeRange] = useState<TimeRange>('today')
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [sources, setSources] = useState<BookingsBySource | null>(null)
  const [funnel, setFunnel] = useState<ConversionFunnel | null>(null)
  const [sparklines, setSparklines] = useState<Sparklines | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    settingsService.getPropertySettings().then((settings: PropertySettings) => {
      setPropertyName(settings.property_name)
      setSlug(settings.slug)
    }).catch(() => {
      setPropertyName('My Property')
      setSlug('my-property')
    })
  }, [])

  const fetchData = useCallback(async (range: TimeRange) => {
    setLoading(true)
    try {
      const [statsData, sourcesData, funnelData, sparklinesData] = await Promise.all([
        dashboardService.getStats(range),
        dashboardService.getBookingsBySource(range),
        dashboardService.getConversionFunnel(range),
        dashboardService.getSparklines(range),
      ])
      setStats(statsData)
      setSources(sourcesData)
      setFunnel(funnelData)
      setSparklines(sparklinesData)
    } catch {
      // Keep existing data on error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData(timeRange)
  }, [timeRange, fetchData])

  const bookingUrl = `https://book.vayada.com/${slug}`

  // Build donut chart gradient
  const donutGradient = sources && sources.sources.length > 0
    ? (() => {
        let cumulative = 0
        const stops = sources.sources.map((s) => {
          const color = SOURCE_COLORS[s.source] || '#d1d5db'
          const start = cumulative
          cumulative += s.percentage
          return `${color} ${start}% ${cumulative}%`
        })
        return `conic-gradient(${stops.join(', ')})`
      })()
    : 'conic-gradient(#e5e7eb 0% 100%)'

  // Sparkline helper
  const renderSparkline = (data: number[], color = 'bg-primary-200') => {
    const max = Math.max(...data, 1)
    return (
      <div className="flex items-end gap-1 mt-3 h-6">
        {data.map((v, i) => (
          <div
            key={i}
            className={`flex-1 ${color} rounded-sm`}
            style={{ height: `${Math.max((v / max) * 100, 4)}%` }}
          />
        ))}
      </div>
    )
  }

  const revenueDiff = stats ? formatDiff(stats.revenue, stats.revenue_previous, true) : null
  const bookingsDiff = stats ? formatDiff(stats.bookings, stats.bookings_previous) : null
  const rateDiff = stats ? formatDiff(stats.avg_nightly_rate, stats.avg_nightly_rate_previous, true) : null
  const viewsDiff = stats ? formatDiff(stats.page_views, stats.page_views_previous) : null

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Booking Engine</h1>
        </div>
      </div>

      {/* Time Range Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {([
          { key: 'today' as TimeRange, label: 'Today' },
          { key: 'week' as TimeRange, label: 'This week' },
          { key: 'month' as TimeRange, label: 'Last 30 days' },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTimeRange(key)}
            className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
              timeRange === key
                ? 'bg-white text-gray-900 border border-gray-200 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Stats Cards */}
      <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 ${loading ? 'opacity-60' : ''}`}>
        {/* Revenue */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Revenue {timeRange === 'today' ? 'Today' : timeRange === 'week' ? 'This Week' : 'Last 30 Days'}</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <p className="text-3xl font-bold text-gray-900 mt-3">{stats ? formatCurrency(stats.revenue) : '--'}</p>
          {revenueDiff && (
            <p className={`text-[13px] mt-1 ${revenueDiff.positive === true ? 'text-green-600' : revenueDiff.positive === false ? 'text-red-500' : 'text-gray-500'}`}>
              {revenueDiff.text}
            </p>
          )}
          {sparklines && renderSparkline(sparklines.revenue)}
        </div>

        {/* New Bookings */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">New Bookings {timeRange === 'today' ? 'Today' : timeRange === 'week' ? 'This Week' : 'Last 30 Days'}</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
            </svg>
          </div>
          <p className="text-3xl font-bold text-gray-900 mt-3">{stats ? stats.bookings : '--'}</p>
          {bookingsDiff && (
            <p className={`text-[13px] mt-1 ${bookingsDiff.positive === true ? 'text-green-600' : bookingsDiff.positive === false ? 'text-red-500' : 'text-gray-500'}`}>
              {bookingsDiff.text}
            </p>
          )}
          {stats?.next_arrival && (
            <p className="text-[11px] text-gray-500 mt-1">
              Next arrival: {new Date(stats.next_arrival).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </p>
          )}
          {sparklines && renderSparkline(sparklines.bookings)}
        </div>

        {/* Avg. Nightly Rate */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Avg. Nightly Rate</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6Z" />
            </svg>
          </div>
          <p className="text-3xl font-bold text-gray-900 mt-3">{stats ? formatCurrency(stats.avg_nightly_rate) : '--'}</p>
          {rateDiff && (
            <p className={`text-[13px] mt-1 ${rateDiff.positive === true ? 'text-green-600' : rateDiff.positive === false ? 'text-red-500' : 'text-gray-500'}`}>
              {rateDiff.text}
            </p>
          )}
          {sparklines && renderSparkline(sparklines.avg_rate)}
        </div>

        {/* Page Views */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Page Views {timeRange === 'today' ? 'Today' : timeRange === 'week' ? 'This Week' : 'Last 30 Days'}</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
          </div>
          <p className="text-3xl font-bold text-gray-900 mt-3">{stats ? stats.page_views : '--'}</p>
          {viewsDiff && (
            <p className={`text-[13px] mt-1 ${viewsDiff.positive === null ? 'text-gray-500' : viewsDiff.positive ? 'text-green-600' : 'text-red-500'}`}>
              {viewsDiff.text}
            </p>
          )}
          {stats && stats.bookings > 0 && stats.page_views > 0 && (
            <p className="text-[11px] text-gray-500 mt-1">
              {((stats.bookings / stats.page_views) * 100).toFixed(1)}% booking rate
            </p>
          )}
          {sparklines && renderSparkline(sparklines.page_views, 'bg-gray-200')}
        </div>
      </div>

      {/* Bookings by Source + Conversion Funnel */}
      <div className={`grid grid-cols-1 lg:grid-cols-2 gap-6 ${loading ? 'opacity-60' : ''}`}>
        {/* Bookings by Source */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-6">Bookings by Source</h3>

          {/* Donut Chart */}
          <div className="flex justify-center mb-6">
            <div className="relative w-48 h-48">
              <div
                className="w-full h-full rounded-full"
                style={{ background: donutGradient }}
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-28 h-28 rounded-full bg-white flex flex-col items-center justify-center">
                  <span className="text-2xl font-bold text-gray-900">
                    {sources ? formatCurrency(sources.total_revenue) : '--'}
                  </span>
                  <span className="text-[11px] text-gray-500">Total Revenue</span>
                </div>
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="space-y-3">
            {sources && sources.sources.length > 0 ? (
              sources.sources.map((s) => (
                <div key={s.source} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full inline-block"
                      style={{ backgroundColor: SOURCE_COLORS[s.source] || '#d1d5db' }}
                    />
                    <span className="text-[13px] text-gray-700">
                      {SOURCE_LABELS[s.source] || s.source}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[13px] font-medium text-gray-900">{s.percentage}%</span>
                    <span className="text-[13px] text-gray-500">{formatCurrency(s.revenue)}</span>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-[13px] text-gray-500 text-center py-4">No booking data for this period</p>
            )}
          </div>

          {/* Info Banner */}
          {sources && sources.sources.length > 0 && sources.sources[0]?.source === 'direct' && sources.sources[0]?.percentage > 50 && (
            <div className="mt-5 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3">
              <p className="text-[13px] text-blue-700">
                {sources.sources[0].percentage}% of bookings came through your vayada page &mdash; great direct booking share!
              </p>
            </div>
          )}
        </div>

        {/* Conversion Funnel */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-6">
            <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              Conversion Funnel &middot; {timeRange === 'today' ? 'Today' : timeRange === 'week' ? 'This Week' : 'Last 30 Days'}
            </h3>
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
            </svg>
          </div>

          <div className="space-y-4">
            {funnel && funnel.steps.length > 0 ? (
              funnel.steps.map(({ label, value, percentage }) => (
                <div key={label}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[13px] text-gray-700">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-gray-900">{value.toLocaleString()}</span>
                      <span className="text-[11px] text-gray-500">{percentage}%</span>
                    </div>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-8">
                    <div
                      className={`h-8 rounded-full transition-all ${
                        label === 'Completed booking' ? 'bg-primary-600' :
                        label === 'Started booking' ? 'bg-primary-500' :
                        'bg-green-200'
                      }`}
                      style={{ width: `${Math.max(percentage, 1)}%` }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="text-[13px] text-gray-500 text-center py-8">No booking data for this period</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
