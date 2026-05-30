"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import { usersService } from "@/services/api/users";
import { marketplaceService, MarketplaceCreator } from "@/services/api/marketplace";
import { collaborationsService } from "@/services/api/collaborations";
import { ApiErrorResponse } from "@/services/api/client";

interface KpiData {
  totalHotels: number;
  verifiedHotels: number;
  totalCreators: number;
  verifiedCreators: number;
  totalListings: number;
  totalCollaborations: number;
  combinedReach: number;
  platformBreakdown: { name: string; followers: number }[];
  avgEngagementRate: number;
}

export default function KpiDashboardPage() {
  const router = useRouter();
  const [kpis, setKpis] = useState<KpiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!authService.isLoggedIn() || !authService.isAdmin()) {
      router.push("/login");
      return;
    }
    loadKpis();
  }, [router]);

  const loadKpis = async () => {
    try {
      setLoading(true);
      const [
        allHotels,
        verifiedHotels,
        allCreators,
        verifiedCreators,
        marketplaceCreators,
        listings,
        collaborations,
      ] = await Promise.all([
        usersService.getAllUsers({ type: "hotel", page: 1, page_size: 1 }),
        usersService.getAllUsers({ type: "hotel", status: "verified", page: 1, page_size: 1 }),
        usersService.getAllUsers({ type: "creator", page: 1, page_size: 1 }),
        usersService.getAllUsers({ type: "creator", status: "verified", page: 1, page_size: 1 }),
        marketplaceService.getCreators(),
        marketplaceService.getListings(),
        collaborationsService.getCollaborations(1, 1),
      ]);

      // Calculate combined reach and platform breakdown
      const platformMap = new Map<string, number>();
      let totalEngagement = 0;
      let platformCount = 0;

      marketplaceCreators.forEach((creator: MarketplaceCreator) => {
        creator.platforms.forEach((p) => {
          platformMap.set(p.name, (platformMap.get(p.name) || 0) + p.followers);
          totalEngagement += p.engagement_rate;
          platformCount++;
        });
      });

      const combinedReach = Array.from(platformMap.values()).reduce((sum, f) => sum + f, 0);
      const platformBreakdown = Array.from(platformMap.entries())
        .map(([name, followers]) => ({ name, followers }))
        .sort((a, b) => b.followers - a.followers);

      setKpis({
        totalHotels: allHotels.total,
        verifiedHotels: verifiedHotels.total,
        totalCreators: allCreators.total,
        verifiedCreators: verifiedCreators.total,
        totalListings: listings.length,
        totalCollaborations: collaborations.total,
        combinedReach,
        platformBreakdown,
        avgEngagementRate: platformCount > 0 ? totalEngagement / platformCount : 0,
      });
    } catch (err) {
      console.error("Error loading KPIs:", err);
      if (err instanceof ApiErrorResponse) {
        setError(err.message);
      } else {
        setError("Failed to load dashboard data");
      }
    } finally {
      setLoading(false);
    }
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
    if (num >= 1000) return (num / 1000).toFixed(1) + "K";
    return num.toString();
  };

  const getPlatformColor = (name: string) => {
    switch (name) {
      case "Instagram":
        return "bg-pink-500";
      case "TikTok":
        return "bg-gray-900";
      case "YouTube":
        return "bg-red-500";
      case "Facebook":
        return "bg-blue-600";
      default:
        return "bg-gray-500";
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="px-6 py-4">
          <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500">Key performance indicators</p>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <p className="text-gray-600">Loading dashboard...</p>
          </div>
        ) : kpis ? (
          <div className="space-y-6">
            {/* Main KPI cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                label="Hotels"
                value={kpis.totalHotels}
                sub={`${kpis.verifiedHotels} verified`}
                color="bg-blue-500"
              />
              <KpiCard
                label="Creators"
                value={kpis.totalCreators}
                sub={`${kpis.verifiedCreators} verified`}
                color="bg-purple-500"
              />
              <KpiCard
                label="Combined Reach"
                value={formatNumber(kpis.combinedReach)}
                sub={`${kpis.avgEngagementRate.toFixed(1)}% avg engagement`}
                color="bg-green-500"
              />
              <KpiCard
                label="Collaborations"
                value={kpis.totalCollaborations}
                sub={`${kpis.totalListings} active listings`}
                color="bg-orange-500"
              />
            </div>

            {/* Platform breakdown */}
            {kpis.platformBreakdown.length > 0 && (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-sm font-semibold text-gray-900 mb-4">Reach by Platform</h2>
                <div className="space-y-3">
                  {kpis.platformBreakdown.map((platform) => {
                    const pct =
                      kpis.combinedReach > 0 ? (platform.followers / kpis.combinedReach) * 100 : 0;
                    return (
                      <div key={platform.name}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="text-gray-700 font-medium">{platform.name}</span>
                          <span className="text-gray-500">
                            {formatNumber(platform.followers)} ({pct.toFixed(0)}%)
                          </span>
                        </div>
                        <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${getPlatformColor(platform.name)}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 pt-4 border-t border-gray-100 flex justify-between text-sm">
                  <span className="text-gray-500">Total combined reach</span>
                  <span className="font-semibold text-gray-900">
                    {formatNumber(kpis.combinedReach)}
                  </span>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: number | string;
  sub: string;
  color: string;
}) {
  return (
    <div className="bg-white rounded-lg shadow p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-2 h-2 rounded-full ${color}`} />
        <p className="text-sm text-gray-500">{label}</p>
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{sub}</p>
    </div>
  );
}
