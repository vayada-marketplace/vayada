export type FinancePayoutStatus =
  | "pending"
  | "scheduled"
  | "processing"
  | "paid"
  | "failed"
  | "canceled"
  | "reversed";

export interface Payout {
  payoutId: string;
  ownerScope: "property" | "organization" | "platform";
  propertyId: string | null;
  organizationId: string | null;
  relatedPropertyId: string | null;
  guestBookingId: string | null;
  paymentId: string | null;
  payoutStatus: FinancePayoutStatus;
  amount: string;
  feeAmount: string;
  netAmount: string;
  currency: string;
  provider: string;
  providerPayoutId: string | null;
  scheduledAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  retryCount: number;
}

export interface PayoutsResponse {
  contractVersion: "finance-route-contracts.v1";
  affiliateId: string;
  payouts: Payout[];
  total: number;
  limit: number;
  offset: number;
  sourceFreshness: Record<string, unknown>;
}
