'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { affiliatesService, Affiliate, AffiliateListResponse } from '@/services/affiliates'

const TIME_RANGES = ['Today', '7 days', '30 days', 'This month'] as const
const MAIN_TABS = ['Applications', 'All Affiliates', 'Payouts', 'Performance'] as const
const TYPE_FILTERS = ['All', 'Guest', 'Creator'] as const

const USER_TYPE_STYLES: Record<string, string> = {
  guest: 'bg-blue-50 text-blue-700',
  creator: 'bg-purple-50 text-purple-700',
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-emerald-50 text-emerald-700',
  rejected: 'bg-red-50 text-red-700',
  suspended: 'bg-gray-100 text-gray-600',
}

function getInitials(name: string) {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function formatCurrency(amount: number) {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function getPayoutLabel(method: string) {
  const labels: Record<string, string> = {
    paypal: 'PayPal',
    bank: 'Bank Transfer',
    stripe: 'Stripe',
    xendit: 'Xendit',
  }
  return labels[method] || method
}

export default function AffiliatesPage() {
  const [affiliates, setAffiliates] = useState<Affiliate[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [timeRange, setTimeRange] = useState<(typeof TIME_RANGES)[number]>('30 days')
  const [mainTab, setMainTab] = useState<(typeof MAIN_TABS)[number]>('Applications')
  const [typeFilter, setTypeFilter] = useState<(typeof TYPE_FILTERS)[number]>('All')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const limit = 20

  const fetchAffiliates = () => {
    setLoading(true)
    affiliatesService
      .list({ limit: 100, offset: 0 })
      .then((res: AffiliateListResponse) => {
        setAffiliates(res.affiliates)
        setTotal(res.total)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchAffiliates()
  }, [])

  const handleApprove = (id: string) => {
    affiliatesService.updateStatus(id, 'approved').then(fetchAffiliates).catch(console.error)
  }

  const handleReject = (id: string) => {
    affiliatesService.updateStatus(id, 'rejected').then(fetchAffiliates).catch(console.error)
  }

  // Computed stats from affiliate data
  const stats = useMemo(() => {
    const active = affiliates.filter((a) => a.status === 'approved')
    const pending = affiliates.filter((a) => a.status === 'pending')
    const paused = affiliates.filter((a) => a.status === 'suspended')
    const totalRevenue = affiliates.reduce((sum, a) => sum + a.totalRevenue, 0)
    const totalBookings = affiliates.reduce((sum, a) => sum + a.bookingCount, 0)
    const totalCommission = affiliates.reduce((sum, a) => sum + a.totalCommission, 0)
    const avgCommission =
      affiliates.length > 0
        ? affiliates.reduce((sum, a) => sum + a.commissionPct, 0) / affiliates.length
        : 0
    const avgPerBooking = totalBookings > 0 ? totalRevenue / totalBookings : 0

    return {
      totalAffiliates: affiliates.length,
      active: active.length,
      pending: pending.length,
      paused: paused.length,
      totalRevenue,
      totalBookings,
      totalCommission,
      avgCommission,
      avgPerBooking,
      activeAffiliates: active.length,
    }
  }, [affiliates])

  // TODO: payouts due — computed from pending commissions; placeholder for now
  const payoutsDue = stats.totalCommission * 0.1
  const payoutsCount = Math.max(1, stats.pending)

  // Filtered lists
  const pendingAffiliates = useMemo(() => {
    let list = affiliates.filter((a) => a.status === 'pending')
    if (typeFilter !== 'All') {
      list = list.filter((a) => a.userType === typeFilter.toLowerCase())
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (a) => a.fullName.toLowerCase().includes(q) || a.email.toLowerCase().includes(q)
      )
    }
    return list
  }, [affiliates, typeFilter, search])

  const allAffiliatesFiltered = useMemo(() => {
    let list = [...affiliates]
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (a) => a.fullName.toLowerCase().includes(q) || a.email.toLowerCase().includes(q)
      )
    }
    return list
  }, [affiliates, search])

  return (
    <div className="p-8 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Affiliates</h1>
          <p className="text-[13px] text-gray-500 mt-1">
            Manage referrals, track performance, and process payouts
          </p>
        </div>
        <Link
          href="/affiliates/commission-settings"
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Commission Settings
        </Link>
      </div>

      {/* Revenue Banner */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-4">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              Revenue Generated via Affiliates
            </p>
            <p className="text-3xl font-bold text-gray-900">{formatCurrency(stats.totalRevenue)}</p>
          </div>
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {TIME_RANGES.map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${
                  timeRange === range
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {range}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-gray-500">
          <span>
            <span className="font-semibold text-gray-900">{stats.totalBookings}</span> Bookings
            referred
          </span>
          <span className="text-gray-300">·</span>
          <span>
            <span className="font-semibold text-gray-900">{stats.activeAffiliates}</span> Active
            affiliates
          </span>
          <span className="text-gray-300">·</span>
          <span>
            <span className="font-semibold text-gray-900">{stats.avgCommission.toFixed(1)}%</span>{' '}
            Avg commission
          </span>
        </div>
      </div>

      {/* Payout Bar */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-3 mb-6 flex items-center justify-between">
        <p className="text-[13px] text-amber-800">
          <span className="font-semibold">{formatCurrency(payoutsDue)}</span> in payouts due to{' '}
          <span className="font-semibold">{payoutsCount}</span> affiliates
        </p>
        <Link
          href="/affiliates/payouts"
          className="text-[13px] font-semibold text-amber-800 hover:text-amber-900 transition-colors"
        >
          Process Payouts &rarr;
        </Link>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Total Affiliates
          </p>
          <p className="text-2xl font-bold text-gray-900">{stats.totalAffiliates}</p>
          <p className="text-[11px] text-gray-500 mt-1">
            {stats.active} active · {stats.pending} pending · {stats.paused} paused
          </p>
          <p className="text-[11px] text-gray-400 font-medium mt-2">0% vs last month</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Revenue via Affiliates
          </p>
          <p className="text-2xl font-bold text-gray-900">{formatCurrency(stats.totalRevenue)}</p>
          <p className="text-[11px] text-gray-500 mt-1">Last 30 days</p>
          <p className="text-[11px] text-gray-400 font-medium mt-2">0% vs last month</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Bookings Referred
          </p>
          <p className="text-2xl font-bold text-gray-900">{stats.totalBookings}</p>
          <p className="text-[11px] text-gray-500 mt-1">
            {formatCurrency(stats.avgPerBooking)} avg per booking
          </p>
          <p className="text-[11px] text-gray-400 font-medium mt-2">0% vs last month</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Commissions Paid
          </p>
          <p className="text-2xl font-bold text-gray-900">
            {formatCurrency(stats.totalCommission)}
          </p>
          <p className="text-[11px] text-gray-500 mt-1">
            {stats.avgCommission.toFixed(1)}% avg rate
          </p>
          <p className="text-[11px] text-gray-400 font-medium mt-2">0% vs last month</p>
        </div>
      </div>

      {/* Main Tabs */}
      <div className="border-b border-gray-200 mb-5">
        <div className="flex gap-6">
          {MAIN_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setMainTab(tab)}
              className={`pb-2.5 text-[13px] font-medium border-b-2 transition-colors ${
                mainTab === tab
                  ? 'border-gray-900 text-gray-900'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab}
              {tab === 'Applications' && stats.pending > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-[10px] font-semibold bg-amber-100 text-amber-700 rounded-full">
                  {stats.pending}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Applications Tab */}
      {mainTab === 'Applications' && (
        <>
          {/* Type filter pills + search */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex gap-2">
              {TYPE_FILTERS.map((type) => (
                <button
                  key={type}
                  onClick={() => setTypeFilter(type)}
                  className={`px-3 py-1.5 text-[12px] font-medium rounded-full border transition-colors ${
                    typeFilter === type
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Search by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64 px-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200"
            />
          </div>

          {loading ? (
            <div className="animate-pulse">
              <div className="h-64 bg-gray-100 rounded-xl" />
            </div>
          ) : pendingAffiliates.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
              <p className="text-[13px] text-gray-500">No pending applications found.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/80">
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Applicant
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Channel
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Payout method
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Applied
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pendingAffiliates.map((a) => (
                    <tr key={a.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-[11px] font-semibold text-gray-500 shrink-0">
                            {getInitials(a.fullName)}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{a.fullName}</p>
                            <p className="text-[11px] text-gray-500">{a.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${USER_TYPE_STYLES[a.userType] || ''}`}
                        >
                          {a.userType}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {a.socialMedia ? (
                          <p className="text-gray-600 text-[12px]">{a.socialMedia}</p>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{getPayoutLabel(a.paymentMethod)}</td>
                      <td className="px-4 py-3 text-gray-500">{formatDate(a.createdAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleApprove(a.id)}
                            className="px-3 py-1.5 text-[12px] font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => handleReject(a.id)}
                            className="px-3 py-1.5 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* All Affiliates Tab */}
      {mainTab === 'All Affiliates' && (
        <>
          <div className="flex items-center justify-end mb-4">
            <input
              type="text"
              placeholder="Search by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64 px-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200"
            />
          </div>

          {loading ? (
            <div className="animate-pulse">
              <div className="h-64 bg-gray-100 rounded-xl" />
            </div>
          ) : allAffiliatesFiltered.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
              <p className="text-[13px] text-gray-500">No affiliates found.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/80">
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Email
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Code
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Clicks
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Bookings
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Conv. Rate
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Revenue
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Commission
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {allAffiliatesFiltered.map((a) => (
                    <tr key={a.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-semibold text-gray-500 shrink-0">
                            {getInitials(a.fullName)}
                          </div>
                          <p className="font-medium text-gray-900">{a.fullName}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{a.email}</td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[11px] bg-gray-100 px-2 py-0.5 rounded">
                          {a.referralCode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${USER_TYPE_STYLES[a.userType] || ''}`}
                        >
                          {a.userType}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {a.clickCount}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {a.bookingCount}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {a.conversionRate > 0 ? `${a.conversionRate}%` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {a.totalRevenue > 0 ? formatCurrency(a.totalRevenue) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {a.totalCommission > 0 ? formatCurrency(a.totalCommission) : '—'}
                        <span className="text-[11px] text-gray-500 ml-1">({a.commissionPct}%)</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${STATUS_STYLES[a.status] || ''}`}
                        >
                          {a.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/affiliates/${a.id}`}
                          className="text-[12px] text-gray-600 hover:text-gray-900 font-medium"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Payouts Tab — placeholder */}
      {mainTab === 'Payouts' && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-[13px] text-gray-500">Payout management coming soon.</p>
        </div>
      )}

      {/* Performance Tab — placeholder */}
      {mainTab === 'Performance' && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-[13px] text-gray-500">Performance analytics coming soon.</p>
        </div>
      )}
    </div>
  )
}
