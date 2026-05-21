'use client'

import { useState, useEffect, useMemo } from 'react'
import { affiliatesService, Affiliate, AffiliateListResponse } from '@/services/affiliates'
import { settingsService } from '@/services/settings'
import { getCurrencySymbol } from '@/lib/utils'

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
  blocked: 'bg-gray-100 text-gray-600',
}

function getInitials(name: string) {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function formatCurrencyAmount(amount: number, symbol: string) {
  return `${symbol}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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
  const [currencySymbol, setCurrencySymbol] = useState('$')
  const [payoutModalAffiliate, setPayoutModalAffiliate] = useState<Affiliate | null>(null)
  const [rateModalAffiliate, setRateModalAffiliate] = useState<Affiliate | null>(null)
  const limit = 20

  useEffect(() => {
    settingsService.getPropertySettings()
      .then((s) => { if (s.default_currency) setCurrencySymbol(getCurrencySymbol(s.default_currency)) })
      .catch(() => {})
  }, [])

  const formatCurrency = (amount: number) => formatCurrencyAmount(amount, currencySymbol)

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

  const handleBlock = (id: string) => {
    affiliatesService.updateStatus(id, 'suspended').then(fetchAffiliates).catch(console.error)
  }

  const handleUnblock = (id: string) => {
    affiliatesService.updateStatus(id, 'approved').then(fetchAffiliates).catch(console.error)
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
        ? affiliates.reduce((sum, a) => sum + a.effectiveCommissionPct, 0) / affiliates.length
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
    <div className="p-4 md:p-8 max-w-[1400px]">
      {/* Header */}
      <div className="mb-5 md:mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Affiliates</h1>
        <p className="text-[13px] text-gray-500 mt-1">
          Manage referrals, track performance, and process payouts
        </p>
      </div>

      {/* Revenue Banner */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6 mb-4">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              Revenue Generated via Affiliates
            </p>
            <p className="text-2xl md:text-3xl font-bold text-gray-900">{formatCurrency(stats.totalRevenue)}</p>
          </div>
          <div className="flex bg-gray-100 rounded-lg p-0.5 w-full md:w-auto">
            {TIME_RANGES.map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`flex-1 md:flex-initial px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-gray-500">
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

      {/* Pending applications banner */}
      {stats.pending > 0 && (
        <button
          onClick={() => setMainTab('Applications')}
          className="w-full mb-4 flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-xl p-3.5 hover:bg-amber-100 transition-colors text-left"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center text-sm font-bold shrink-0">
              {stats.pending}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-amber-900 truncate">
                {stats.pending === 1
                  ? '1 affiliate application waiting for review'
                  : `${stats.pending} affiliate applications waiting for review`}
              </p>
              <p className="text-[11px] text-amber-700 truncate">
                Approve or reject pending referrers in the Applications tab
              </p>
            </div>
          </div>
          <span className="shrink-0 text-[12px] font-medium text-amber-800">Review →</span>
        </button>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-5 md:mb-6">
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Total Affiliates
          </p>
          <p className="text-2xl font-bold text-gray-900">{stats.totalAffiliates}</p>
          <p className="text-[11px] text-gray-500 mt-1">
            {stats.active} active · {stats.pending} pending · {stats.paused} paused
          </p>
          <p className="text-[11px] text-gray-400 font-medium mt-2">0% vs last month</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Revenue via Affiliates
          </p>
          <p className="text-2xl font-bold text-gray-900">{formatCurrency(stats.totalRevenue)}</p>
          <p className="text-[11px] text-gray-500 mt-1">Last 30 days</p>
          <p className="text-[11px] text-gray-400 font-medium mt-2">0% vs last month</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Bookings Referred
          </p>
          <p className="text-2xl font-bold text-gray-900">{stats.totalBookings}</p>
          <p className="text-[11px] text-gray-500 mt-1">
            {formatCurrency(stats.avgPerBooking)} avg per booking
          </p>
          <p className="text-[11px] text-gray-400 font-medium mt-2">0% vs last month</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
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
      <div className="relative border-b border-gray-200 mb-4 md:mb-5">
        <div className="overflow-x-auto scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0">
        <div className="flex gap-4 md:gap-6">
          {MAIN_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setMainTab(tab)}
              className={`shrink-0 whitespace-nowrap pb-2.5 text-[13px] font-medium border-b-2 transition-colors ${
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
        <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-gray-50 to-transparent pointer-events-none lg:hidden" />
      </div>

      {/* Applications Tab */}
      {mainTab === 'Applications' && (
        <>
          {/* Type filter pills + search */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
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
              className="w-full sm:w-64 px-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200"
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
            <>
            {/* Mobile cards */}
            <div className="md:hidden space-y-2.5">
              {pendingAffiliates.map((a) => (
                <div key={a.id} className="bg-white border border-gray-200 rounded-xl p-3.5">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-[11px] font-semibold text-gray-500 shrink-0">
                        {getInitials(a.fullName)}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">{a.fullName}</p>
                        <p className="text-[11px] text-gray-500 truncate">{a.email}</p>
                      </div>
                    </div>
                    <span className={`shrink-0 inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${USER_TYPE_STYLES[a.userType] || ''}`}>
                      {a.userType}
                    </span>
                  </div>
                  <div className="text-[12px] text-gray-500 space-y-0.5 border-t border-gray-100 pt-2 mb-3">
                    {a.socialMedia && <p>Channel: <span className="text-gray-700">{a.socialMedia}</span></p>}
                    <p>Payout: <span className="text-gray-700">{getPayoutLabel(a.paymentMethod)}</span></p>
                    <p>Applied: <span className="text-gray-700">{formatDate(a.createdAt)}</span></p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApprove(a.id)}
                      className="flex-1 py-2 text-[12px] font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleReject(a.id)}
                      className="flex-1 py-2 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/80">
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Applicant</th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Type</th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Channel</th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Payout method</th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Applied</th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pendingAffiliates.map((a) => (
                    <tr key={a.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-[11px] font-semibold text-gray-500 shrink-0">{getInitials(a.fullName)}</div>
                          <div>
                            <p className="font-medium text-gray-900">{a.fullName}</p>
                            <p className="text-[11px] text-gray-500">{a.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${USER_TYPE_STYLES[a.userType] || ''}`}>{a.userType}</span>
                      </td>
                      <td className="px-4 py-3">{a.socialMedia ? <p className="text-gray-600 text-[12px]">{a.socialMedia}</p> : <span className="text-gray-400">—</span>}</td>
                      <td className="px-4 py-3 text-gray-600">{getPayoutLabel(a.paymentMethod)}</td>
                      <td className="px-4 py-3 text-gray-500">{formatDate(a.createdAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => handleApprove(a.id)} className="px-3 py-1.5 text-[12px] font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors">Approve</button>
                          <button onClick={() => handleReject(a.id)} className="px-3 py-1.5 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Reject</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </>
      )}

      {/* All Affiliates Tab */}
      {mainTab === 'All Affiliates' && (
        <>
          <DefaultCommissionCard />

          <div className="flex items-center justify-end mb-4">
            <input
              type="text"
              placeholder="Search by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-64 px-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200"
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
            <>
            {/* Mobile cards */}
            <div className="md:hidden space-y-2.5">
              {allAffiliatesFiltered.map((a) => (
                <div key={a.id} className="bg-white border border-gray-200 rounded-xl p-3.5">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-[11px] font-semibold text-gray-500 shrink-0">{getInitials(a.fullName)}</div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">{a.fullName}</p>
                        <p className="text-[11px] text-gray-500 truncate">{a.email}</p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${STATUS_STYLES[a.status] || ''}`}>
                        {a.status === 'suspended' ? 'Blocked' : a.status}
                      </span>
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${USER_TYPE_STYLES[a.userType] || ''}`}>{a.userType}</span>
                    </div>
                  </div>
                  <div className="border-t border-gray-100 pt-2 mb-2">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-mono text-[11px] bg-gray-100 px-2 py-0.5 rounded">{a.referralCode}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-[10px] text-gray-400">Clicks</p>
                        <p className="text-sm font-semibold text-gray-900">{a.clickCount}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-400">Bookings</p>
                        <p className="text-sm font-semibold text-gray-900">{a.bookingCount}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-400">Revenue</p>
                        <p className="text-sm font-semibold text-gray-900">{a.totalRevenue > 0 ? formatCurrency(a.totalRevenue) : '—'}</p>
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-gray-100 pt-2 flex gap-2">
                    <button onClick={() => setPayoutModalAffiliate(a)} className="flex-1 py-1.5 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">View payout</button>
                    {a.status === 'approved' ? (
                      <button onClick={() => handleBlock(a.id)} className="flex-1 py-1.5 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Block</button>
                    ) : a.status === 'suspended' ? (
                      <button onClick={() => handleUnblock(a.id)} className="flex-1 py-1.5 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Unblock</button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/80">
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Email</th>
                    <th className="text-left px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Code</th>
                    <th className="text-center px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Type</th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Clicks</th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Bookings</th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Conv. Rate</th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Revenue</th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Commission</th>
                    <th className="text-center px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {allAffiliatesFiltered.map((a) => (
                    <tr key={a.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-semibold text-gray-500 shrink-0">{getInitials(a.fullName)}</div>
                          <p className="font-medium text-gray-900">{a.fullName}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{a.email}</td>
                      <td className="px-4 py-3"><span className="font-mono text-[11px] bg-gray-100 px-2 py-0.5 rounded">{a.referralCode}</span></td>
                      <td className="px-4 py-3 text-center"><span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${USER_TYPE_STYLES[a.userType] || ''}`}>{a.userType}</span></td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{a.clickCount}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{a.bookingCount}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{a.conversionRate > 0 ? `${a.conversionRate}%` : '—'}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{a.totalRevenue > 0 ? formatCurrency(a.totalRevenue) : '—'}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {a.totalCommission > 0 ? formatCurrency(a.totalCommission) : '—'}
                        <span className="text-[11px] text-gray-500 ml-1">({a.effectiveCommissionPct}%)</span>
                        {a.commissionPctOverride !== null && (
                          <span className="ml-1 inline-flex px-1.5 py-0 rounded-full text-[9px] font-semibold bg-amber-50 text-amber-700" title="Custom rate — click Set rate to change or revert">Custom</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center"><span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${STATUS_STYLES[a.status] || ''}`}>{a.status === 'suspended' ? 'Blocked' : a.status}</span></td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={(e) => { e.stopPropagation(); setPayoutModalAffiliate(a) }} className="px-3 py-1 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">View payout</button>
                          <button onClick={(e) => { e.stopPropagation(); setRateModalAffiliate(a) }} className="px-3 py-1 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Set rate</button>
                          {a.status === 'approved' ? (
                            <button onClick={(e) => { e.stopPropagation(); handleBlock(a.id) }} className="px-3 py-1 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Block</button>
                          ) : a.status === 'suspended' ? (
                            <button onClick={(e) => { e.stopPropagation(); handleUnblock(a.id) }} className="px-3 py-1 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Unblock</button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
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

      {payoutModalAffiliate && (
        <PayoutDetailsModal
          affiliate={payoutModalAffiliate}
          onClose={() => setPayoutModalAffiliate(null)}
        />
      )}

      {rateModalAffiliate && (
        <CommissionRateModal
          affiliate={rateModalAffiliate}
          onClose={() => setRateModalAffiliate(null)}
          onSaved={(updated) => {
            setAffiliates((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
            setRateModalAffiliate(null)
          }}
        />
      )}
    </div>
  )
}

function CommissionRateModal({
  affiliate,
  onClose,
  onSaved,
}: {
  affiliate: Affiliate
  onClose: () => void
  onSaved: (updated: Affiliate) => void
}) {
  const [value, setValue] = useState<number>(affiliate.effectiveCommissionPct)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasOverride = affiliate.commissionPctOverride !== null

  const handleSave = async () => {
    if (value < 0 || value > 100) {
      setError('Must be between 0 and 100')
      return
    }
    setSaving(true)
    try {
      const updated = await affiliatesService.updateCommission(affiliate.id, value)
      onSaved(updated)
    } catch {
      setError('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleRevert = async () => {
    setSaving(true)
    try {
      const updated = await affiliatesService.updateCommission(affiliate.id, null)
      onSaved(updated)
    } catch {
      setError('Failed to revert')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-md w-full p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[14px] font-semibold text-gray-900">Commission rate for {affiliate.fullName}</h3>
        <p className="text-[12px] text-gray-500 mt-1 mb-4">
          Hotel default: <strong>{affiliate.defaultCommissionPct}%</strong>
          {hasOverride ? (
            <> · Currently custom: <strong>{affiliate.commissionPctOverride}%</strong></>
          ) : (
            <> · This affiliate uses the default.</>
          )}
        </p>

        <label className="block text-[12px] font-medium text-gray-700 mb-1">Custom rate</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-[14px] font-semibold text-center focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <span className="text-[13px] text-gray-600">%</span>
        </div>
        {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}

        <div className="flex items-center justify-between mt-5 gap-2">
          {hasOverride ? (
            <button
              onClick={handleRevert}
              disabled={saving}
              className="px-3 py-2 text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Revert to default
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 text-[12px] font-medium text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-[12px] font-semibold text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PayoutDetailsModal({ affiliate, onClose }: { affiliate: Affiliate; onClose: () => void }) {
  const method = affiliate.paymentMethod
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-3 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Payout Details</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">{affiliate.fullName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <Field label="Method" value={
            method === 'paypal' ? 'PayPal' :
            method === 'bank' ? 'Bank Transfer' :
            method === 'stripe' ? 'Stripe Connect' :
            method === 'xendit' ? 'Xendit' : method
          } />

          {method === 'stripe' && (
            <>
              <Field label="Account ID" value={affiliate.stripeConnectAccountId || '—'} mono />
              <Field label="Onboarded" value={affiliate.stripeConnectOnboarded ? 'Yes' : 'Not yet'} />
            </>
          )}

          {method === 'paypal' && (
            <Field label="PayPal Email" value={affiliate.paypalEmail || '—'} />
          )}

          {method === 'bank' && (
            <>
              <Field label="Account Holder" value={affiliate.bankAccountHolder || '—'} />
              <Field label="IBAN / Account" value={affiliate.bankIban || '—'} mono />
              <Field label="SWIFT / BIC" value={affiliate.bankSwiftBic || '—'} mono />
              <Field label="Bank Name" value={affiliate.bankName || '—'} />
              <Field label="Country" value={affiliate.bankCountry || '—'} />
            </>
          )}

          {method === 'xendit' && (
            <>
              <Field label="Channel" value={affiliate.xenditChannelCode || '—'} />
              <Field label="Account Number" value={affiliate.xenditAccountNumber || '—'} mono />
              <Field label="Account Holder" value={affiliate.xenditAccountHolderName || '—'} />
            </>
          )}

          <div className="pt-3 border-t border-gray-100 text-[11px] text-gray-400">
            Contact email: <span className="text-gray-600">{affiliate.email}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-sm text-gray-900 ${mono ? 'font-mono' : ''} break-all`}>{value}</p>
    </div>
  )
}

function DefaultCommissionCard() {
  const [pct, setPct] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    affiliatesService.getDefaultCommission()
      .then((r) => setPct(r.defaultCommissionPct))
      .catch(() => setPct(5))
  }, [])

  const handleSave = async () => {
    if (editing === null) return
    if (editing < 0 || editing > 100) {
      setFeedback('Must be between 0 and 100')
      return
    }
    setSaving(true)
    try {
      const r = await affiliatesService.updateDefaultCommission(editing)
      setPct(r.defaultCommissionPct)
      setEditing(null)
      setFeedback('Saved')
      setTimeout(() => setFeedback(null), 2000)
    } catch {
      setFeedback('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (pct === null) {
    return <div className="mb-4 h-16 bg-gray-100 rounded-lg animate-pulse" />
  }

  return (
    <div className="mb-4 bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
      <div>
        <p className="text-[13px] font-semibold text-gray-900">Default affiliate commission</p>
        <p className="text-[12px] text-gray-500">Applied to every new affiliate unless overridden for a specific one.</p>
      </div>
      <div className="flex items-center gap-2">
        {editing === null ? (
          <>
            <span className="text-[14px] font-semibold text-gray-900">{pct}%</span>
            <button
              onClick={() => setEditing(pct)}
              className="px-3 py-1.5 text-[12px] font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Edit
            </button>
          </>
        ) : (
          <>
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={editing}
              onChange={(e) => setEditing(Number(e.target.value))}
              className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-[13px] font-semibold text-center focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <span className="text-[13px] text-gray-600">%</span>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-[12px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(null); setFeedback(null) }}
              className="px-3 py-1.5 text-[12px] font-medium text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Cancel
            </button>
          </>
        )}
        {feedback && <span className="text-[12px] text-gray-500">{feedback}</span>}
      </div>
    </div>
  )
}
