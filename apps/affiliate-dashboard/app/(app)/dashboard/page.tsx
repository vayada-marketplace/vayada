'use client'

import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import StatsCard from '@/components/StatsCard'
import PropertyCard from '@/components/PropertyCard'
import EarningsChart from '@/components/EarningsChart'
import PayoutHistory from '@/components/PayoutHistory'
import RecentActivity from '@/components/RecentActivity'
import PerformanceTips from '@/components/PerformanceTips'
import { apiClient } from '@/services/api/client'
import { authService } from '@/services/auth'
import type {
  AffiliateProperty,
  DashboardStats,
  PropertiesResponse,
} from '@/services/types'

const PROPERTY_COLORS = ['#0f766e', '#1e3a5f', '#6b21a8', '#b45309', '#be123c', '#047857']

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [properties, setProperties] = useState<AffiliateProperty[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const userName = authService.getUserName()
  const userInitials = authService.getUserInitials()

  useEffect(() => {
    async function load() {
      try {
        const [dashData, propData] = await Promise.all([
          apiClient.get<DashboardStats>('/affiliate/dashboard'),
          apiClient.get<PropertiesResponse>('/affiliate/properties'),
        ])
        setStats(dashData)
        setProperties(propData.properties)
      } catch (err) {
        console.error('Failed to load dashboard:', err)
        setError('Failed to load dashboard data.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-gray-500 text-sm">Loading dashboard...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-red-600 text-sm">{error}</div>
      </div>
    )
  }

  const avgPerBooking = stats && stats.totalBookings > 0
    ? Math.round(stats.totalEarned / stats.totalBookings)
    : 0

  return (
    <div className="min-h-screen bg-slate-100">
      <Navbar userName={userName} userInitials={userInitials} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Greeting */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
            Hey {userName.split(' ')[0]}
          </h1>
          <p className="text-muted mt-1">
            You&apos;re an affiliate at {stats?.propertyCount || 0} propert{(stats?.propertyCount || 0) === 1 ? 'y' : 'ies'}
          </p>
        </div>

        {/* Stats overview */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatsCard
            label="Total Earned"
            value={`$${(stats?.totalEarned || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
            subtitle={`Across ${stats?.propertyCount || 0} properties`}
          />
          <StatsCard
            label="Bookings Referred"
            value={(stats?.totalBookings || 0).toString()}
            subtitle={`Avg $${avgPerBooking} per booking`}
          />
          <StatsCard
            label="Link Clicks"
            value={(stats?.totalClicks || 0).toString()}
            subtitle={`${stats?.conversionRate || 0}% conversion rate`}
          />
          <StatsCard
            label="Outstanding Balance"
            value={`$${(stats?.outstandingBalance || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
            subtitle="Across all properties"
            highlight
          />
        </div>

        {/* Property cards */}
        {properties.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Your Properties</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {properties.map((property, i) => (
                <PropertyCard
                  key={property.affiliateId}
                  name={property.hotelName}
                  commission={property.commissionPct}
                  status={property.status === 'approved' ? 'active' : 'pending'}
                  affiliateLink={`${property.hotelSlug}.vayada.com?ref=${property.referralCode}`}
                  bookings={property.bookingCount}
                  outstanding={property.totalCommission}
                  clicks={property.clickCount}
                  color={PROPERTY_COLORS[i % PROPERTY_COLORS.length]}
                />
              ))}
            </div>
          </div>
        )}

        {/* Charts + Activity row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
          <EarningsChart />
          <RecentActivity />
        </div>

        {/* Payouts + Tips row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <PayoutHistory />
          <PerformanceTips />
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-sm text-muted">
            &copy; 2026 vayada. All rights reserved.
          </p>
          <div className="flex gap-6 text-sm text-muted">
            <a href="#" className="hover:text-gray-700 transition-colors">Help Center</a>
            <a href="#" className="hover:text-gray-700 transition-colors">Terms</a>
            <a href="#" className="hover:text-gray-700 transition-colors">Privacy</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
