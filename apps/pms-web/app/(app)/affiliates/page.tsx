'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { affiliatesService, Affiliate, AffiliateListResponse } from '@/services/affiliates'
import { AFFILIATE_STATUS_STYLES } from '@/lib/constants/statusStyles'
import FilterTabs from '@/components/FilterTabs'
import Pagination from '@/components/Pagination'

const STATUS_TABS = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Suspended', value: 'suspended' },
]

const USER_TYPE_STYLES: Record<string, string> = {
  guest: 'bg-blue-50 text-blue-700',
  creator: 'bg-purple-50 text-purple-700',
}

export default function AffiliatesPage() {
  const [affiliates, setAffiliates] = useState<Affiliate[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [offset, setOffset] = useState(0)
  const limit = 20

  const fetchAffiliates = () => {
    setLoading(true)
    affiliatesService
      .list({ status: statusFilter || undefined, limit, offset })
      .then((res: AffiliateListResponse) => {
        setAffiliates(res.affiliates)
        setTotal(res.total)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setOffset(0)
  }, [statusFilter])

  useEffect(() => {
    fetchAffiliates()
  }, [statusFilter, offset])

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-gray-900 mb-6">Affiliates</h1>

      <FilterTabs tabs={STATUS_TABS} activeValue={statusFilter} onChange={setStatusFilter} />

      {loading ? (
        <div className="animate-pulse">
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      ) : affiliates.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-gray-500">No affiliates found.</p>
        </div>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Code</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Type</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Clicks</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Bookings</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Conv. Rate</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Revenue</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Commission</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {affiliates.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => window.location.href = `/affiliates/${a.id}`}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{a.fullName}</p>
                      {a.socialMedia && (
                        <p className="text-xs text-gray-500">{a.socialMedia}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{a.email}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded">{a.referralCode}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${USER_TYPE_STYLES[a.userType] || ''}`}>
                        {a.userType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">{a.clickCount}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">{a.bookingCount}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {a.conversionRate > 0 ? `${a.conversionRate}%` : '-'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {a.totalRevenue > 0 ? `EUR ${a.totalRevenue.toFixed(2)}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {a.totalCommission > 0 ? `EUR ${a.totalCommission.toFixed(2)}` : '-'}
                      <span className="text-xs text-gray-500 ml-1">({a.commissionPct}%)</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${AFFILIATE_STATUS_STYLES[a.status] || ''}`}>
                        {a.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/affiliates/${a.id}`}
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
