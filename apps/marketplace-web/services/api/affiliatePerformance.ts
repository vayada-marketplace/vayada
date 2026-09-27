import { targetApiClient } from "./targetClient";

export const AFFILIATE_PERFORMANCE_PERIODS = ["1m", "3m", "6m", "12m"] as const;
export const AFFILIATE_PERFORMANCE_SOURCES = [
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "x",
  "unknown",
] as const;

export type AffiliatePerformancePeriod = (typeof AFFILIATE_PERFORMANCE_PERIODS)[number];
export type AffiliatePerformanceSource = (typeof AFFILIATE_PERFORMANCE_SOURCES)[number];

export type AffiliatePerformancePartnership = {
  agreementId: string;
  propertyId: string;
  propertyName: string;
  creatorProfileId: string;
  clicks: number;
  bookings: number;
  stays: { total: number; calculated: number; pending: number; needsReview: number };
  commissions: Array<{
    currency: string;
    currencyMinorUnit: number;
    calculatedMinor: string;
    adjustmentMinor: string;
  }>;
  sources: Array<{ source: string; clicks: number }>;
  campaigns: Array<{ campaign: string | null; clicks: number }>;
  freshness: "current" | "stale" | "unknown";
};

export type AffiliatePerformancePage = {
  contractVersion: "affiliate-performance.v1";
  coverage: "available";
  readAt: string;
  period: { from: string; to: string };
  filters: { propertyId: string | null; source: string | null; campaign: string | null };
  partnerships: AffiliatePerformancePartnership[];
  nextCursor: string | null;
};

export type AffiliatePerformanceFilters = {
  period: AffiliatePerformancePeriod;
  propertyId?: string;
  source?: AffiliatePerformanceSource;
  campaign?: string;
  cursor?: string;
};

export function affiliatePerformancePath(filters: AffiliatePerformanceFilters): string {
  const query = new URLSearchParams({ period: filters.period, limit: "50" });
  if (filters.propertyId) query.set("propertyId", filters.propertyId);
  if (filters.source) query.set("source", filters.source);
  if (filters.campaign?.trim()) query.set("campaign", filters.campaign.trim());
  if (filters.cursor) query.set("cursor", filters.cursor);
  return `/api/marketplace/affiliate-performance?${query}`;
}

export function getAffiliatePerformance(
  filters: AffiliatePerformanceFilters,
  signal?: AbortSignal,
): Promise<AffiliatePerformancePage> {
  return targetApiClient.get(affiliatePerformancePath(filters), { signal });
}
