import Navbar from '@/components/Navbar'
import StatsCard from '@/components/StatsCard'
import PropertyCard from '@/components/PropertyCard'
import EarningsChart from '@/components/EarningsChart'
import PayoutHistory from '@/components/PayoutHistory'
import RecentActivity from '@/components/RecentActivity'
import PerformanceTips from '@/components/PerformanceTips'

// Mock data — in production this comes from the API
const user = {
  name: 'Sarah',
  initials: 'SC',
}

const stats = {
  totalEarned: 2640,
  bookingsReferred: 21,
  avgPerBooking: 126,
  linkClicks: 501,
  conversionRate: 4.2,
  outstandingBalance: 1260,
  propertyCount: 3,
}

const properties = [
  {
    name: 'Sundancer Lombok',
    commission: 10,
    status: 'active' as const,
    affiliateLink: 'book.vayada.com/sundancer-lombok?ref=sarah',
    bookings: 14,
    outstanding: 840,
    clicks: 312,
    color: '#0f766e',
  },
  {
    name: 'Coral Bay Resort',
    commission: 8,
    status: 'active' as const,
    affiliateLink: 'book.vayada.com/coral-bay?ref=aff_sarah',
    bookings: 7,
    outstanding: 420,
    clicks: 189,
    color: '#1e3a5f',
  },
  {
    name: 'Villa Seraya',
    commission: 12,
    status: 'pending' as const,
    affiliateLink: 'book.vayada.com/villa-seraya?ref=a_sarah',
    bookings: 0,
    outstanding: 0,
    clicks: 0,
    color: '#6b21a8',
  },
]

export default function AffiliateDashboard() {
  return (
    <div className="min-h-screen bg-slate-100">
      <Navbar userName={user.name} userInitials={user.initials} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Greeting */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
            Hey {user.name} <span className="inline-block animate-bounce">&#128075;</span>
          </h1>
          <p className="text-muted mt-1">
            You&apos;re an affiliate at {stats.propertyCount} properties &middot; total earnings across all
          </p>
        </div>

        {/* Stats overview */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatsCard
            label="Total Earned"
            value={`$${stats.totalEarned.toLocaleString()}`}
            subtitle={`Across ${stats.propertyCount} properties`}
          />
          <StatsCard
            label="Bookings Referred"
            value={stats.bookingsReferred.toString()}
            subtitle={`Avg $${stats.avgPerBooking} per booking`}
          />
          <StatsCard
            label="Link Clicks"
            value={stats.linkClicks.toString()}
            subtitle={`${stats.conversionRate}% conversion rate`}
          />
          <StatsCard
            label="Outstanding Balance"
            value={`$${stats.outstandingBalance.toLocaleString()}`}
            subtitle="Across all properties"
            highlight
          />
        </div>

        {/* Property cards */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Your Properties</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {properties.map((property) => (
              <PropertyCard key={property.name} {...property} />
            ))}
          </div>
        </div>

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
