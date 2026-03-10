'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { bookingsService, Booking, BookingListResponse } from '@/services/bookings'
import { MagnifyingGlassIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline'

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-50 text-yellow-700',
  confirmed: 'bg-green-50 text-green-700',
  checked_in: 'bg-green-50 text-green-700',
  in_house: 'bg-teal-50 text-teal-700',
  cancelled: 'bg-red-50 text-red-600',
  expired: 'bg-gray-100 text-gray-600',
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
  paid: 'text-green-600',
  partial: 'text-orange-500',
  due: 'text-orange-500',
  refunded: 'text-purple-600',
}

const SOURCE_ICONS: Record<string, { bg: string }> = {
  direct: { bg: 'bg-blue-500' },
  airbnb: { bg: 'bg-pink-500' },
  'booking.com': { bg: 'bg-indigo-600' },
  expedia: { bg: 'bg-yellow-500' },
  beds24: { bg: 'bg-purple-500' },
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

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    bookings.forEach((b) => {
      counts[b.status] = (counts[b.status] || 0) + 1
    })
    return counts
  }, [bookings])

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

  const visibleTabs = STATUS_TABS.filter((t) => t.value === '' || t.count > 0 || t.value === statusFilter)

  return (
    <div className="p-6 pb-0">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Reservations</h1>
        <p className="text-sm text-gray-500 mt-1">Master ledger of all bookings</p>
      </div>

      {/* Search & Filters */}
      <div className="flex items-center gap-3 mb-5">
        <div className="relative max-w-sm">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by guest, reservation ID, or room..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-80 pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
          />
        </div>
        <button className="flex items-center gap-2 px-3 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4" />
            <path d="M8 2v4" />
            <path d="M3 10h18" />
          </svg>
          Filter by date range
          <svg className="w-3 h-3 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      {/* Status Tabs */}
      <div className="flex items-center gap-5 mb-6">
        {visibleTabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatusFilter(tab.value)}
            className={`text-sm transition-colors ${
              statusFilter === tab.value
                ? 'text-gray-900 font-semibold'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className="ml-1 text-xs">({tab.count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-16 bg-gray-50 rounded" />
          ))}
        </div>
      ) : filteredBookings.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-gray-400 text-sm">No reservations found.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[200px]">Guest</th>
                <th className="text-left px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[110px]">Status</th>
                <th className="text-left px-4 pb-3 pt-4 text-xs font-medium text-gray-400">Room</th>
                <th className="text-left px-4 pb-3 pt-4 text-xs font-medium text-gray-400">Stay Period</th>
                <th className="text-right px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[90px]">Total</th>
                <th className="text-center px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[80px]">Balance</th>
                <th className="text-center px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[70px]">Source</th>
                <th className="w-10 pt-4"></th>
              </tr>
            </thead>
            <tbody>
              {filteredBookings.map((b) => {
                const guestExtra = getGuestCount(b)
                const nights = getNights(b.checkIn, b.checkOut)
                const balance = getBalanceStatus(b)
                const source = SOURCE_ICONS[b.channel] || SOURCE_ICONS['direct']
                return (
                  <tr key={b.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/50 transition-colors group">
                    {/* Guest */}
                    <td className="px-4 py-4">
                      <Link href={`/bookings/${b.id}`} className="block">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-medium text-gray-900 group-hover:text-primary-600 transition-colors">
                            {b.guestFirstName} {b.guestLastName}
                          </span>
                          {guestExtra > 0 && (
                            <span className="text-[11px] text-gray-400 font-medium">+{guestExtra}</span>
                          )}
                        </div>
                        <p className="text-[11px] text-gray-400 mt-0.5">{b.bookingReference}</p>
                      </Link>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-4">
                      <span className={`inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold ${STATUS_STYLES[b.status] || STATUS_STYLES['pending']}`}>
                        {STATUS_LABELS[b.status] || b.status}
                      </span>
                    </td>

                    {/* Room */}
                    <td className="px-4 py-4 text-[13px] text-gray-600">
                      {b.roomNumber ? (
                        <>
                          <span className="font-medium text-gray-800">#{b.roomNumber}</span>
                          <span className="text-gray-400"> - </span>
                          {b.roomName}
                        </>
                      ) : (
                        b.roomName
                      )}
                    </td>

                    {/* Stay Period */}
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-1.5 text-[13px] text-gray-600">
                        <span>{formatDate(b.checkIn)}</span>
                        <span className="text-gray-300">&rarr;</span>
                        <span>{formatDate(b.checkOut)}</span>
                        <span className="flex items-center gap-0.5 text-[12px] text-gray-400 ml-2">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                          </svg>
                          {nights}
                        </span>
                      </div>
                    </td>

                    {/* Total */}
                    <td className="px-4 py-4 text-right text-[13px] font-semibold text-gray-900">
                      ${b.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </td>

                    {/* Balance */}
                    <td className="px-4 py-4 text-center">
                      <span className={`text-[11px] font-semibold capitalize ${BALANCE_STYLES[balance] || BALANCE_STYLES['due']}`}>
                        {balance === 'paid' ? 'Paid' : balance === 'partial' ? 'Partial' : balance === 'refunded' ? 'Refunded' : 'Due'}
                      </span>
                    </td>

                    {/* Source */}
                    <td className="px-4 py-4 text-center">
                      <span
                        className={`inline-flex w-6 h-6 items-center justify-center rounded-md ${source.bg}`}
                        title={b.channel || 'Direct'}
                      >
                        <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M2 12h20" />
                          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-4 text-right">
                      <Link
                        href={`/bookings/${b.id}`}
                        className="p-1 rounded-md hover:bg-gray-100 transition-colors inline-flex"
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
            <div className="flex items-center justify-between px-4 py-4 border-t border-gray-200">
              <p className="text-sm text-gray-400">
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
