'use client'

import { useState, useEffect } from 'react'
import { bookingsService, Payout, PayoutListResponse } from '@/services/bookings'
import { PAYOUT_STATUS_STYLES } from '@/lib/constants/statusStyles'
import FilterTabs from '@/components/FilterTabs'
import Pagination from '@/components/Pagination'

const STATUS_TABS = [
  { label: 'All', value: '' },
  { label: 'Scheduled', value: 'scheduled' },
  { label: 'Processing', value: 'processing' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
]

export default function PayoutsPage() {
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [offset, setOffset] = useState(0)
  const limit = 20

  const fetchPayouts = () => {
    setLoading(true)
    bookingsService
      .getPayouts({ status: statusFilter || undefined, limit, offset })
      .then((res: PayoutListResponse) => {
        setPayouts(res.payouts)
        setTotal(res.total)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setOffset(0)
  }, [statusFilter])

  useEffect(() => {
    fetchPayouts()
  }, [statusFilter, offset])

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-gray-900 mb-6">Payouts</h1>

      <FilterTabs tabs={STATUS_TABS} activeValue={statusFilter} onChange={setStatusFilter} />

      {loading ? (
        <div className="animate-pulse">
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      ) : payouts.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-gray-500">No payouts found.</p>
        </div>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Booking</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Recipient</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Amount</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Scheduled</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payouts.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <span className="font-mono font-medium text-gray-900">
                        {p.bookingReference || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                        p.recipientType === 'hotel' ? 'bg-indigo-100 text-indigo-700' : 'bg-purple-100 text-purple-700'
                      }`}>
                        {p.recipientType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {p.currency} {p.amount.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${PAYOUT_STATUS_STYLES[p.status] || ''}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">
                      {new Date(p.scheduledFor).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">
                      {p.completedAt ? new Date(p.completedAt).toLocaleDateString() : '—'}
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
