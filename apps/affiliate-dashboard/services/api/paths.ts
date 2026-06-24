import type { EarningsPeriod } from "@/services/types";

export const affiliateApiPaths = {
  me: "/api/affiliate/me",
  dashboard: "/api/affiliate/dashboard",
  properties: "/api/affiliate/properties",
  earnings: (period: EarningsPeriod) =>
    `/api/affiliate/earnings?period=${encodeURIComponent(period)}`,
  activity: (limit: number) => `/api/affiliate/activity?limit=${limit}`,
  payouts: "/api/affiliate/payouts",
  payoutSettings: "/api/affiliate/payout-settings",
} as const;
