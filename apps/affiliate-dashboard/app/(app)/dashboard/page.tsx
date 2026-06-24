"use client";

import useSWR from "swr";
import Navbar from "@/components/Navbar";
import StatsCard from "@/components/StatsCard";
import PropertyCard from "@/components/PropertyCard";
import EarningsChart from "@/components/EarningsChart";
import PayoutHistory from "@/components/PayoutHistory";
import RecentActivity from "@/components/RecentActivity";
import PerformanceTips from "@/components/PerformanceTips";
import { affiliateApiPaths } from "@/services/api/paths";
import { authService } from "@/services/auth";
import { affiliateLink } from "@/services/constants/site";
import type { AffiliateDashboardResponse, AffiliatePropertiesResponse } from "@/services/types";

const PROPERTY_COLORS = ["#0f766e", "#1e3a5f", "#6b21a8", "#b45309", "#be123c", "#047857"];

export default function DashboardPage() {
  const { data: dashboard, error: statsError } = useSWR<AffiliateDashboardResponse>(
    affiliateApiPaths.dashboard,
  );
  const { data: propertiesData, error: propertiesError } = useSWR<AffiliatePropertiesResponse>(
    affiliateApiPaths.properties,
  );

  const userName = authService.getUserName();
  const userInitials = authService.getUserInitials();

  if (statsError || propertiesError) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-red-600 text-sm">Failed to load dashboard data.</div>
      </div>
    );
  }

  if (!dashboard || !propertiesData) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-gray-500 text-sm">Loading dashboard...</div>
      </div>
    );
  }

  const stats = dashboard.summary;
  const properties = propertiesData.properties;
  const avgPerBooking =
    stats.bookingCount > 0
      ? Math.round(Number(stats.totalCommissionAmount) / stats.bookingCount)
      : 0;

  return (
    <div className="min-h-screen bg-slate-100">
      <Navbar userName={userName} userInitials={userInitials} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Greeting */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
            Hey {userName.split(" ")[0]}
          </h1>
          <p className="text-muted mt-1">
            You&apos;re an affiliate at {stats.propertyCount} propert
            {stats.propertyCount === 1 ? "y" : "ies"}
          </p>
        </div>

        {/* Stats overview */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatsCard
            label="Total Earned"
            value={formatMoney(stats.totalCommissionAmount, stats.currency)}
            subtitle={`Across ${stats.propertyCount} properties`}
          />
          <StatsCard
            label="Bookings Referred"
            value={stats.bookingCount.toString()}
            subtitle={`Avg ${formatMoney(String(avgPerBooking), stats.currency)} per booking`}
          />
          <StatsCard
            label="Link Clicks"
            value={stats.clickCount.toString()}
            subtitle={`${stats.conversionRate}% conversion rate`}
          />
          <StatsCard
            label="Outstanding Balance"
            value={formatMoney(stats.outstandingBalanceAmount, stats.currency)}
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
                  key={property.propertyId}
                  name={property.displayName}
                  commission={property.commissionPercent}
                  status={property.status === "active" ? "active" : "pending"}
                  affiliateLink={affiliateLink(property.slug, property.referralCode)}
                  bookings={property.metrics.bookingCount}
                  outstanding={Number(property.metrics.totalCommissionAmount)}
                  clicks={property.metrics.clickCount}
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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <p className="text-sm text-muted text-center sm:text-left">
            &copy; 2026 vayada. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}

function formatMoney(amount: string, currency: string): string {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `${currency} ${amount}`;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch {
    return `${currency} ${numeric.toLocaleString()}`;
  }
}
