'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { bookingsService, Booking, BookingListResponse } from '@/services/bookings'
import { MagnifyingGlassIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline'

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-50 text-yellow-700 border border-yellow-200',
  confirmed: 'bg-green-50 text-green-700 border border-green-200',
  checked_in: 'bg-green-50 text-green-700 border border-green-200',
  in_house: 'bg-teal-50 text-teal-700 border border-teal-200',
  cancelled: 'bg-red-50 text-red-600 border border-red-200',
  expired: 'bg-gray-50 text-gray-600 border border-gray-200',
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  checked_in: 'Checked In',
  in_house: 'In-House',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

const BALANCE_STYLES: Record<string, string> = {
  paid: 'bg-green-50 text-green-700 border border-green-200',
  partial: 'bg-orange-50 text-orange-600 border border-orange-200',
  due: 'bg-orange-50 text-orange-600 border border-orange-200',
  refunded: 'bg-purple-50 text-purple-600 border border-purple-200',
}

const SOURCE_ICONS: Record<string, { bg: string; icon: string }> = {
  direct: { bg: 'bg-blue-500', icon: 'D' },
  airbnb: { bg: 'bg-pink-500', icon: 'A' },
  'booking.com': { bg: 'bg-indigo-600', icon: 'B' },
  expedia: { bg: 'bg-yellow-500', icon: 'E' },
  beds24: { bg: 'bg-purple-500', icon: 'B' },
}

function getBalanceStatus(b: Booking): string {
  if (b.status === 'cancelled') return b.paymentStatus === 'refunded' ? 'refunded' : 'due'
  if (b.paymentStatus === 'captured') return 'paid'
  if (b.paymentStatus === 'authorized') return 'partial'
  if (b.paymentMethod === 'pay_at_property') return 'due'
  return 'due'
}

function getNights(checkIn: string, checkOut: string): number {
  const d1 = new Date(checkIn)
  const d2 = new Date(checkOut)
  return Math.max(1, Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24)))
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getGuestCount(b: Booking): number {
  return (b.adults || 1) + (b.children || 0) - 1
}

export default function ReservationsPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const limit = 20

  const fetchBookings = () => {
    setLoading(true)
    bookingsService
      .list({ status: statusFilter || undefined, limit, offset })
      .then((res: BookingListResponse) => {
        setBookings(res.bookings)
        setTotal(res.total)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setOffset(0)
  }, [statusFilter])

  useEffect(() => {
    fetchBookings()
  }, [statusFilter, offset])

  // Count bookings by status for tab badges
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    bookings.forEach((b) => {
      counts[b.status] = (counts[b.status] || 0) + 1
    })
    return counts
  }, [bookings])

  // Filter by search locally
  const filteredBookings = useMemo(() => {
    if (!searchQuery.trim()) return bookings
    const q = searchQuery.toLowerCase()
    return bookings.filter(
      (b) =>
        b.guestFirstName?.toLowerCase().includes(q) ||
        b.guestLastName?.toLowerCase().includes(q) ||
        b.bookingReference?.toLowerCase().includes(q) ||
        b.roomName?.toLowerCase().includes(q) ||
        b.guestEmail?.toLowerCase().includes(q)
    )
  }, [bookings, searchQuery])

  const STATUS_TABS = [
    { label: 'All', value: '', count: total },
    { label: 'Confirmed', value: 'confirmed', count: statusCounts['confirmed'] || 0 },
    { label: 'Checked In', value: 'checked_in', count: statusCounts['checked_in'] || 0 },
    { label: 'In-House', value: 'in_house', count: statusCounts['in_house'] || 0 },
    { label: 'Cancelled', value: 'cancelled', count: statusCounts['cancelled'] || 0 },
    { label: 'Pending', value: 'pending', count: statusCounts['pending'] || 0 },
    { label: 'Expired', value: 'expired', count: statusCounts['expired'] || 0 },
  ]

  // Only show tabs that have counts > 0 (except All which always shows)
  const visibleTabs = STATUS_TABS.filter((t) => t.value === '' || t.count > 0 || t.value === statusFilter)

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Reservations</h1>
        <p className="text-sm text-gray-500 mt-0.5">Master ledger of all bookings</p>
      </div>

      {/* Search & Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by guest, reservation ID, or room..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
          />
        </div>
        <button className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4" />
            <path d="M8 2v4" />
            <path d="M3 10h18" />
          </svg>
          Filter by date range
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      {/* Status Tabs */}
      <div className="flex gap-1 mb-5 border-b border-gray-200">
        {visibleTabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatusFilter(tab.value)}
            className={`px-3 py-2 text-sm font-medium transition-colors relative ${
              statusFilter === tab.value
                ? 'text-gray-900'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className={`ml-1.5 text-xs ${statusFilter === tab.value ? 'text-gray-700' : 'text-gray-400'}`}>
                ({tab.count})
              </span>
            )}
            {statusFilter === tab.value && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-gray-900 rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-gray-100 rounded-lg" />
          ))}
        </div>
      ) : filteredBookings.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-gray-500">No reservations found.</p>
        </div>
      ) : (
        <div className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Guest</th>
                <th className="text-left py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="text-left py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Room</th>
                <th className="text-left py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Stay Period</th>
                <th className="text-right py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                <th className="text-center py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Balance</th>
                <th className="text-center py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Source</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {filteredBookings.map((b) => {
                const guestExtra = getGuestCount(b)
                const nights = getNights(b.checkIn, b.checkOut)
                const balance = getBalanceStatus(b)
                const source = SOURCE_ICONS[b.channel] || SOURCE_ICONS['direct']
                return (
                  <tr key={b.id} className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                    {/* Guest */}
                    <td className="py-3.5 pr-4">
                      <Link href={`/bookings/${b.id}`} className="block group">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 group-hover:text-primary-600 transition-colors">
                            {b.guestFirstName} {b.guestLastName}
                          </span>
                          {guestExtra > 0 && (
                            <span className="text-xs text-gray-400">+{guestExtra}</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5 font-mono">{b.bookingReference}</p>
                      </Link>
                    </td>

                    {/* Status */}
                    <td className="py-3.5 pr-4">
                      <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[b.status] || STATUS_STYLES['pending']}`}>
                        {STATUS_LABELS[b.status] || b.status}
                      </span>
                    </td>

                    {/* Room */}
                    <td className="py-3.5 pr-4 text-gray-600">
                      {b.roomNumber && (
                        <span className="text-gray-400">#{b.roomNumber} - </span>
                      )}
                      {b.roomName}
                    </td>

                    {/* Stay Period */}
                    <td className="py-3.5 pr-4">
                      <div className="flex items-center gap-2 text-gray-600">
                        <span>{formatDate(b.checkIn)}</span>
                        <svg className="w-3 h-3 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12h14" />
                          <path d="M12 5l7 7-7 7" />
                        </svg>
                        <span>{formatDate(b.checkOut)}</span>
                        <span className="flex items-center gap-1 text-xs text-gray-400 ml-1">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 6v6l4 2" />
                          </svg>
                          {nights}
                        </span>
                      </div>
                    </td>

                    {/* Total */}
                    <td className="py-3.5 pr-4 text-right font-medium text-gray-900">
                      {b.currency === 'EUR' ? '\u20AC' : b.currency === 'USD' ? '$' : b.currency}{' '}
                      {b.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </td>

                    {/* Balance */}
                    <td className="py-3.5 pr-4 text-center">
                      <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium capitalize ${BALANCE_STYLES[balance] || BALANCE_STYLES['due']}`}>
                        {balance}
                      </span>
                    </td>

                    {/* Source */}
                    <td className="py-3.5 pr-2 text-center">
                      <span
                        className={`inline-flex w-7 h-7 items-center justify-center rounded-md text-white text-xs font-bold ${source.bg}`}
                        title={b.channel || 'Direct'}
                      >
                        {source.icon}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="py-3.5">
                      <Link
                        href={`/bookings/${b.id}`}
                        className="p-1 rounded hover:bg-gray-100 transition-colors inline-flex"
                      >
                        <EllipsisHorizontalIcon className="w-5 h-5 text-gray-400" />
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {total > limit && (
            <div className="flex items-center justify-between py-4 border-t border-gray-200 mt-2">
              <p className="text-sm text-gray-500">
                Showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  disabled={offset === 0}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() => setOffset(offset + limit)}
                  disabled={offset + limit >= total}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
