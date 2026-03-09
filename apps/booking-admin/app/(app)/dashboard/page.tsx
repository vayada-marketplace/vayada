'use client'

// TODO: Replace mock data with real API calls when dashboard endpoints are available

import { useEffect, useState } from 'react'
import { settingsService, type PropertySettings } from '@/services/settings'

type TimeRange = 'today' | 'week' | 'month' | 'custom'

export default function DashboardPage() {
  const [propertyName, setPropertyName] = useState('')
  const [slug, setSlug] = useState('')
  const [timeRange, setTimeRange] = useState<TimeRange>('today')

  useEffect(() => {
    settingsService.getPropertySettings().then((settings: PropertySettings) => {
      setPropertyName(settings.property_name)
      setSlug(settings.slug)
    }).catch(() => {
      setPropertyName('My Property')
      setSlug('my-property')
    })
  }, [])

  const bookingUrl = `https://book.vayada.com/${slug}`

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Booking Engine</h1>
          <p className="text-lg text-gray-700 mt-1">{propertyName}</p>
          <div className="flex items-center gap-3 mt-2">
            <a
              href={bookingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] text-primary-600 hover:underline"
            >
              book.vayada.com/{slug}
            </a>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-green-600 font-medium">
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
              Live since Mar 1
            </span>
          </div>
        </div>
        <a
          href={bookingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white text-[13px] font-medium rounded-lg hover:bg-primary-700 transition-colors"
        >
          View Live Page
          <span className="text-sm">&nearr;</span>
        </a>
      </div>

      {/* Time Range Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {([
          { key: 'today' as TimeRange, label: 'Today' },
          { key: 'week' as TimeRange, label: 'This week' },
          { key: 'month' as TimeRange, label: 'Last 30 days' },
          { key: 'custom' as TimeRange, label: 'Custom' },
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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Revenue Today */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Revenue Today</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <p className="text-3xl font-bold text-gray-900 mt-3">$1,260</p>
          <p className="text-[13px] text-green-600 mt-1">&uarr; +$340 vs yesterday</p>
          {/* Mini sparkline */}
          <div className="flex items-end gap-1 mt-3 h-6">
            {[40, 55, 35, 60, 45, 70, 85].map((h, i) => (
              <div key={i} className="flex-1 bg-primary-200 rounded-sm" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>

        {/* New Bookings Today */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">New Bookings Today</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
            </svg>
          </div>
          <p className="text-3xl font-bold text-gray-900 mt-3">3</p>
          <p className="text-[13px] text-green-600 mt-1">&uarr; 2 more than yesterday</p>
          <p className="text-[11px] text-gray-500 mt-1">Next arrival: Mar 3</p>
          {/* Mini sparkline */}
          <div className="flex items-end gap-1 mt-3 h-6">
            {[30, 50, 20, 70, 40, 55, 90].map((h, i) => (
              <div key={i} className="flex-1 bg-primary-200 rounded-sm" style={{ height: `${h}%` }} />
            ))}
          </div>
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
          <p className="text-3xl font-bold text-gray-900 mt-3">$420</p>
          <p className="text-[13px] text-green-600 mt-1">&uarr; +$35 vs monthly avg</p>
          <p className="text-[11px] text-gray-500 mt-1">Peak rate active</p>
          {/* Mini sparkline */}
          <div className="flex items-end gap-1 mt-3 h-6">
            {[60, 45, 55, 50, 65, 75, 80].map((h, i) => (
              <div key={i} className="flex-1 bg-primary-200 rounded-sm" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>

        {/* Page Views Today */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Page Views Today</span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
          </div>
          <p className="text-3xl font-bold text-gray-900 mt-3">47</p>
          <p className="text-[13px] text-gray-500 mt-1">&rarr; Similar to yesterday</p>
          <p className="text-[11px] text-gray-500 mt-1">3.2% booking rate today</p>
          {/* Mini sparkline */}
          <div className="flex items-end gap-1 mt-3 h-6">
            {[50, 55, 45, 50, 60, 48, 52].map((h, i) => (
              <div key={i} className="flex-1 bg-gray-200 rounded-sm" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      </div>

      {/* Bookings by Source + Conversion Funnel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bookings by Source */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-6">Bookings by Source</h3>

          {/* Donut Chart */}
          <div className="flex justify-center mb-6">
            <div className="relative w-48 h-48">
              <div
                className="w-full h-full rounded-full"
                style={{
                  background: 'conic-gradient(#1e3a5f 0% 68%, #3b82f6 68% 92%, #93c5fd 92% 100%)',
                }}
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-28 h-28 rounded-full bg-white flex flex-col items-center justify-center">
                  <span className="text-2xl font-bold text-gray-900">$18,400</span>
                  <span className="text-[11px] text-gray-500">Total Revenue</span>
                </div>
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: '#1e3a5f' }} />
                <span className="text-[13px] text-gray-700">Direct (Vayada)</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[13px] font-medium text-gray-900">68%</span>
                <span className="text-[13px] text-gray-500">$12,512</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: '#3b82f6' }} />
                <span className="text-[13px] text-gray-700">Booking.com</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[13px] font-medium text-gray-900">24%</span>
                <span className="text-[13px] text-gray-500">$4,416</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: '#93c5fd' }} />
                <span className="text-[13px] text-gray-700">Airbnb</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[13px] font-medium text-gray-900">8%</span>
                <span className="text-[13px] text-gray-500">$1,472</span>
              </div>
            </div>
          </div>

          {/* Info Banner */}
          <div className="mt-5 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3">
            <p className="text-[13px] text-blue-700">
              Your best month for direct share &mdash; 68% of bookings came through your Vayada page.
            </p>
          </div>
        </div>

        {/* Conversion Funnel */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-6">
            <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              Conversion Funnel &middot; Last 30 Days
            </h3>
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
            </svg>
          </div>

          <div className="space-y-4">
            {([
              { label: 'Page visits', value: 847, pct: 100, color: 'bg-green-200' },
              { label: 'Searched dates', value: 612, pct: 72, color: 'bg-green-200' },
              { label: 'Viewed a room', value: 389, pct: 46, color: 'bg-green-200' },
              { label: 'Started booking', value: 94, pct: 11, color: 'bg-primary-500' },
              { label: 'Completed booking', value: 71, pct: 8.4, color: 'bg-primary-600' },
            ]).map(({ label, value, pct, color }) => (
              <div key={label}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[13px] text-gray-700">{label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-gray-900">{value.toLocaleString()}</span>
                    <span className="text-[11px] text-gray-500">{pct}%</span>
                  </div>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-8">
                  <div
                    className={`${color} h-8 rounded-full transition-all`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
