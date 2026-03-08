'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { bookingsService, Booking, BookingListResponse } from '@/services/bookings'
import { BOOKING_STATUS_STYLES } from '@/lib/constants/statusStyles'
import FilterTabs from '@/components/FilterTabs'
import Pagination from '@/components/Pagination'

const STATUS_TABS = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Confirmed', value: 'confirmed' },
  { label: 'Cancelled', value: 'cancelled' },
  { label: 'Expired', value: 'expired' },
]

function isDeadlineUrgent(deadline: string | null): boolean {
  if (!deadline) return false
  const diff = new Date(deadline).getTime() - Date.now()
  return diff > 0 && diff < 4 * 60 * 60 * 1000 // Less than 4 hours
}

export default function BookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
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

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-gray-900 mb-6">Bookings</h1>

      <FilterTabs tabs={STATUS_TABS} activeValue={statusFilter} onChange={setStatusFilter} />

      {loading ? (
        <div className="animate-pulse">
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      ) : bookings.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-gray-500">No bookings found.</p>
        </div>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Reference</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Guest</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Room</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Dates</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Total</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Payment</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bookings.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium text-gray-900">{b.bookingReference}</span>
                        {b.status === 'pending' && b.hostResponseDeadline && isDeadlineUrgent(b.hostResponseDeadline) && (
                          <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-600 animate-pulse">
                            URGENT
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-gray-900">{b.guestFirstName} {b.guestLastName}</p>
                        <p className="text-xs text-gray-500">{b.guestEmail}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{b.roomName}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {b.checkIn} &rarr; {b.checkOut}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {b.currency} {b.totalAmount.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${BOOKING_STATUS_STYLES[b.status] || ''}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="text-xs text-gray-500">
                        {b.paymentMethod === 'card' ? 'Card' : b.paymentMethod === 'pay_at_property' ? 'Property' : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/bookings/${b.id}`}
                        className="text-primary-600 hover:text-primary-700 font-medium"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination total={total} limit={limit} offset={offset} onOffsetChange={setOffset} />
        </>
      )}
    </div>
  )
}
