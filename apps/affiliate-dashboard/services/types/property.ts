export interface AffiliateProperty {
  affiliateId: string;
  propertyId: string;
  displayName: string;
  slug: string;
  referralCode: string;
  commissionPercent: number;
  status: "active" | "pending" | "suspended";
  metrics: {
    bookingCount: number;
    totalRevenueAmount: string;
    totalCommissionAmount: string;
    clickCount: number;
    conversionRate: number;
  };
}

export interface AffiliatePropertiesResponse {
  contractVersion: "affiliate-dashboard.v1";
  affiliateId: string;
  properties: AffiliateProperty[];
}
