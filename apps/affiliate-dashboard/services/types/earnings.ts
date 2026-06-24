export type EarningsPeriod = "1m" | "3m" | "6m" | "12m";

export interface EarningsBucket {
  bucketStart: string;
  label: string;
  commissionAmount: string;
}

export interface EarningsResponse {
  contractVersion: "affiliate-dashboard.v1";
  affiliateId: string;
  period: EarningsPeriod;
  currency: string;
  buckets: EarningsBucket[];
  sourceFreshness: Record<string, unknown>;
}
