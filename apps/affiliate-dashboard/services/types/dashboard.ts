export interface AffiliateDashboardResponse {
  contractVersion: "affiliate-dashboard.v1";
  affiliateId: string;
  summary: AffiliateDashboardSummary;
}

export interface AffiliateDashboardSummary {
  currency: string;
  totalCommissionAmount: string;
  bookingCount: number;
  clickCount: number;
  conversionRate: number;
  propertyCount: number;
  outstandingBalanceAmount: string;
  sourceFreshness: Record<string, unknown>;
}
