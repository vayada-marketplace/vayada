'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from '@/lib/i18n'
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

function formatCurrencyWithCode(value: number, currencyCode: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value)
}

function formatDiff(current: number, previous: number, isCurrency = false, currencyCode = 'EUR', t?: (key: string) => string, vsLabel?: string): { text: string; positive: boolean | null } {
  const diff = current - previous
  if (diff === 0 && current === 0) return { text: t ? t('dashboard.stats.noDataYet') : 'No data yet', positive: null }
  if (diff === 0) return { text: t ? t('dashboard.stats.samePeriod') : 'Same as previous period', positive: null }
  const formatted = isCurrency ? formatCurrencyWithCode(Math.abs(diff), currencyCode) : Math.abs(diff).toString()
  const vsPrevious = vsLabel ?? (t ? t('dashboard.stats.vsPrevious') : 'vs previous')
  if (diff > 0) return { text: `\u2191 +${formatted} ${vsPrevious}`, positive: true }
  return { text: `\u2193 -${formatted} ${vsPrevious}`, positive: false }
}

// Mirrors DashboardRepository._sparkline_buckets in the backend so the modal's
// bar labels match the bucket boundaries the API actually returned.
function sparklineBuckets(range: TimeRange): { start: Date; end: Date }[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dayMs = 24 * 60 * 60 * 1000
  if (range === 'month') {
    return Array.from({ length: 7 }, (_, i) => {
      const start = new Date(today.getTime() - (27 - i * 4) * dayMs)
      const end = i < 6 ? new Date(today.getTime() - (27 - (i + 1) * 4 + 1) * dayMs) : today
      return { start, end }
    })
  }
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today.getTime() - (6 - i) * dayMs)
    return { start: d, end: d }
  })
}

function formatBucketLabel(bucket: { start: Date; end: Date }, locale: string): string {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  if (bucket.start.getTime() === bucket.end.getTime()) return fmt.format(bucket.start)
  return `${fmt.format(bucket.start)}\u2013${fmt.format(bucket.end)}`
}

export default function DashboardPage() {
  const { t, locale } = useTranslation()
  const [propertyName, setPropertyName] = useState('')
  const [timeRange, setTimeRange] = useState<TimeRange>('today')
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [sources, setSources] = useState<BookingsBySource | null>(null)
  const [funnel, setFunnel] = useState<ConversionFunnel | null>(null)
  const [sparklines, setSparklines] = useState<Sparklines | null>(null)
  const [currency, setCurrency] = useState('EUR')
  const [loading, setLoading] = useState(true)
  const [pageViewsModalOpen, setPageViewsModalOpen] = useState(false)

  useEffect(() => {
    settingsService.getPropertySettings().then((settings: PropertySettings) => {
      setPropertyName(settings.property_name)
      if (settings.default_currency) setCurrency(settings.default_currency)
    }).catch(() => {
      setPropertyName('My Property')
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

  // mt-auto pins the sparkline to the card bottom so optional subtitle lines don't shift the baseline.
  const renderSparkline = (data: number[], color = 'bg-primary-200') => {
    const max = Math.max(...data, 1)
    return (
      <div className="flex items-end gap-1 mt-auto pt-3 h-6">
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

  // Scale down for long currency strings (e.g. "IDR 1,234,567,890") so the label fits the inner circle.
  const donutValueFontSize = (text: string): string => {
    if (text.length <= 8) return 'text-xl md:text-2xl'
    if (text.length <= 12) return 'text-base md:text-xl'
    return 'text-sm md:text-base'
  }

  // The previous-period comparison was a vague "vs previous"; spell out
  // the actual comparison window so hotel managers can read the delta.
  const vsLabel = timeRange === 'today'
    ? t('dashboard.stats.vsYesterday')
    : timeRange === 'week'
    ? t('dashboard.stats.vsLastWeek')
    : t('dashboard.stats.vsLast30Days')

  const revenueDiff = stats ? formatDiff(stats.revenue, stats.revenue_previous, true, currency, t, vsLabel) : null
  const bookingsDiff = stats ? formatDiff(stats.bookings, stats.bookings_previous, false, 'EUR', t, vsLabel) : null
  const rateDiff = stats ? formatDiff(stats.avg_nightly_rate, stats.avg_nightly_rate_previous, true, currency, t, vsLabel) : null
  const viewsDiff = stats ? formatDiff(stats.page_views, stats.page_views_previous, false, 'EUR', t, vsLabel) : null

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-5 md:space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t('dashboard.title')}</h1>
      </div>

      {/* Time Range Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-full sm:w-fit">
        {([
          { key: 'today' as TimeRange, label: t('dashboard.timeRange.today') },
          { key: 'week' as TimeRange, label: t('dashboard.timeRange.week') },
          { key: 'month' as TimeRange, label: t('dashboard.timeRange.month') },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTimeRange(key)}
            className={`flex-1 sm:flex-initial px-4 py-2 sm:py-1.5 rounded-md text-[13px] font-medium transition-colors ${
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
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5 flex flex-col">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{t('dashboard.stats.revenue')} {timeRange === 'today' ? t('dashboard.timeRange.today') : timeRange === 'week' ? t('dashboard.timeRange.week') : t('dashboard.timeRange.month')}</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <p className="text-2xl md:text-3xl font-bold text-gray-900 mt-3 truncate">{stats ? formatCurrencyWithCode(stats.revenue, currency) : '--'}</p>
          {revenueDiff && (
            <p className={`text-[13px] mt-1 ${revenueDiff.positive === true ? 'text-green-600' : revenueDiff.positive === false ? 'text-red-500' : 'text-gray-500'}`}>
              {revenueDiff.text}
            </p>
          )}
          {sparklines && renderSparkline(sparklines.revenue)}
        </div>

        {/* New Bookings */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5 flex flex-col">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{t('dashboard.stats.newBookings')} {timeRange === 'today' ? t('dashboard.timeRange.today') : timeRange === 'week' ? t('dashboard.timeRange.week') : t('dashboard.timeRange.month')}</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
            </svg>
          </div>
          <p className="text-2xl md:text-3xl font-bold text-gray-900 mt-3 truncate">{stats ? stats.bookings : '--'}</p>
          {bookingsDiff && (
            <p className={`text-[13px] mt-1 ${bookingsDiff.positive === true ? 'text-green-600' : bookingsDiff.positive === false ? 'text-red-500' : 'text-gray-500'}`}>
              {bookingsDiff.text}
            </p>
          )}
          {stats?.next_arrival && (
            <p className="text-[11px] text-gray-500 mt-1">
              {t('dashboard.stats.nextArrival')} {new Date(stats.next_arrival).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </p>
          )}
          {sparklines && renderSparkline(sparklines.bookings)}
        </div>

        {/* Avg. Nightly Rate */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5 flex flex-col">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{t('dashboard.stats.avgNightlyRate')}</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6Z" />
            </svg>
          </div>
          <p className="text-2xl md:text-3xl font-bold text-gray-900 mt-3 truncate">{stats ? formatCurrencyWithCode(stats.avg_nightly_rate, currency) : '--'}</p>
          {rateDiff && (
            <p className={`text-[13px] mt-1 ${rateDiff.positive === true ? 'text-green-600' : rateDiff.positive === false ? 'text-red-500' : 'text-gray-500'}`}>
              {rateDiff.text}
            </p>
          )}
          {sparklines && renderSparkline(sparklines.avg_rate)}
        </div>

        {/* Page Views */}
        <button
          type="button"
          onClick={() => setPageViewsModalOpen(true)}
          className="bg-white border border-gray-200 rounded-xl p-4 md:p-5 flex flex-col text-left hover:border-gray-300 hover:shadow-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-300"
          aria-label={t('dashboard.pageViewsModal.openLabel')}
        >
          <div className="flex items-start justify-between w-full">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{t('dashboard.stats.pageViews')} {timeRange === 'today' ? t('dashboard.timeRange.today') : timeRange === 'week' ? t('dashboard.timeRange.week') : t('dashboard.timeRange.month')}</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
          </div>
          <p className="text-2xl md:text-3xl font-bold text-gray-900 mt-3 truncate w-full">{stats ? stats.page_views : '--'}</p>
          {viewsDiff && (
            <p className={`text-[13px] mt-1 ${viewsDiff.positive === null ? 'text-gray-500' : viewsDiff.positive ? 'text-green-600' : 'text-red-500'}`}>
              {viewsDiff.text}
            </p>
          )}
          {stats && stats.bookings > 0 && stats.page_views > 0 && (
            <p className="text-[11px] text-gray-500 mt-1">
              {((stats.bookings / stats.page_views) * 100).toFixed(1)}% {t('dashboard.stats.bookingRate')}
            </p>
          )}
          {sparklines && renderSparkline(sparklines.page_views, 'bg-gray-200')}
        </button>
      </div>

      {pageViewsModalOpen && sparklines && (
        <PageViewsDetailModal
          range={timeRange}
          sparkline={sparklines.page_views}
          current={stats?.page_views ?? 0}
          previous={stats?.page_views_previous ?? 0}
          locale={locale}
          t={t}
          onClose={() => setPageViewsModalOpen(false)}
        />
      )}

      {/* Bookings by Source + Conversion Funnel */}
      <div className={`grid grid-cols-1 lg:grid-cols-2 gap-6 ${loading ? 'opacity-60' : ''}`}>
        {/* Bookings by Source */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-6">{t('dashboard.bookingsBySource.title')}</h3>

          {/* Donut Chart */}
          <div className="flex justify-center mb-6">
            <div className="relative w-40 h-40 md:w-48 md:h-48">
              <div
                className="w-full h-full rounded-full"
                style={{ background: donutGradient }}
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-28 h-28 md:w-32 md:h-32 rounded-full bg-white flex flex-col items-center justify-center px-2">
                  {(() => {
                    const valueText = sources ? formatCurrencyWithCode(sources.total_revenue, currency) : '--'
                    return (
                      <span className={`${donutValueFontSize(valueText)} font-bold text-gray-900 text-center whitespace-nowrap`}>
                        {valueText}
                      </span>
                    )
                  })()}
                  <span className="text-[11px] text-gray-500 text-center whitespace-nowrap">{t('dashboard.bookingsBySource.totalRevenue')}</span>
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
                      {s.source === 'direct' ? t('dashboard.bookingsBySource.direct') : (SOURCE_LABELS[s.source] || s.source)}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[13px] font-medium text-gray-900">{s.percentage}%</span>
                    <span className="text-[13px] text-gray-500">{formatCurrencyWithCode(s.revenue, currency)}</span>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-[13px] text-gray-500 text-center py-4">{t('dashboard.bookingsBySource.noData')}</p>
            )}
          </div>

          {/* Info Banner */}
          {sources && sources.sources.length > 0 && sources.sources[0]?.source === 'direct' && sources.sources[0]?.percentage > 50 && (
            <div className="mt-5 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3">
              <p className="text-[13px] text-blue-700">
                {sources.sources[0].percentage}% {t('dashboard.bookingsBySource.directBookingShare')}
              </p>
            </div>
          )}
        </div>

        {/* Conversion Funnel */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
          <div className="flex items-center gap-2 mb-6">
            <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              {t('dashboard.conversionFunnel.title')} &middot; {timeRange === 'today' ? t('dashboard.timeRange.today') : timeRange === 'week' ? t('dashboard.timeRange.week') : t('dashboard.timeRange.month')}
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
                  <div className="w-full bg-gray-100 rounded-full h-8 overflow-hidden">
                    <div
                      className={`h-8 rounded-full transition-all ${
                        label === 'Completed booking' ? 'bg-primary-600' :
                        label === 'Started booking' ? 'bg-primary-500' :
                        'bg-green-200'
                      }`}
                      style={{ width: `${Math.min(Math.max(percentage, 1), 100)}%` }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="text-[13px] text-gray-500 text-center py-8">{t('dashboard.bookingsBySource.noData')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface PageViewsDetailModalProps {
  range: TimeRange
  sparkline: number[]
  current: number
  previous: number
  locale: string
  t: (key: string, params?: Record<string, string | number>) => string
  onClose: () => void
}

function PageViewsDetailModal({ range, sparkline, current, previous, locale, t, onClose }: PageViewsDetailModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const buckets = sparklineBuckets(range)
  const max = Math.max(...sparkline, 1)
  const total = sparkline.reduce((a, b) => a + b, 0)
  const diff = current - previous
  const pctChange = previous > 0 ? Math.round((diff / previous) * 100) : null

  const periodLabel = range === 'today'
    ? t('dashboard.pageViewsModal.subtitleToday')
    : range === 'week'
    ? t('dashboard.pageViewsModal.subtitleWeek')
    : t('dashboard.pageViewsModal.subtitleMonth')

  const vsLabel = range === 'today'
    ? t('dashboard.stats.vsYesterday')
    : range === 'week'
    ? t('dashboard.stats.vsLastWeek')
    : t('dashboard.stats.vsLast30Days')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-lg font-semibold text-gray-900">{t('dashboard.pageViewsModal.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 -mr-2 -mt-1 p-2"
            aria-label={t('dashboard.pageViewsModal.close')}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p className="text-[13px] text-gray-500 mb-5">{periodLabel}</p>

        <div className="flex items-end gap-2 h-40 mb-2">
          {sparkline.map((v, i) => (
            <div key={i} className="flex-1 flex flex-col items-center justify-end h-full">
              <span className="text-[11px] font-medium text-gray-700 mb-1">{v}</span>
              <div
                className="w-full bg-primary-500 rounded-t"
                style={{ height: `${Math.max((v / max) * 100, 2)}%` }}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2 mb-5">
          {buckets.map((b, i) => (
            <span key={i} className="flex-1 text-center text-[11px] text-gray-500 truncate" title={formatBucketLabel(b, locale)}>
              {formatBucketLabel(b, locale)}
            </span>
          ))}
        </div>

        <div className="border-t border-gray-100 pt-4 grid grid-cols-2 gap-4 text-[13px]">
          <div>
            <div className="text-gray-500">{t('dashboard.pageViewsModal.totalInWindow')}</div>
            <div className="text-xl font-semibold text-gray-900">{total}</div>
          </div>
          <div>
            <div className="text-gray-500">{vsLabel}</div>
            <div className={`text-xl font-semibold ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-500' : 'text-gray-900'}`}>
              {diff > 0 ? '+' : ''}{diff}
              {pctChange !== null && (
                <span className="text-[13px] font-normal ml-2">({diff > 0 ? '+' : ''}{pctChange}%)</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
