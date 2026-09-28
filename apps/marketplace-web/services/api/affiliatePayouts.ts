import { targetApiClient } from "./targetClient";

export type AffiliatePayout = {
  payoutId: string;
  payoutStatus:
    | "pending"
    | "scheduled"
    | "processing"
    | "paid"
    | "failed"
    | "canceled"
    | "reversed";
  amount: string;
  feeAmount: string;
  netAmount: string;
  currency: string;
  scheduledAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  retryCount: number;
};

export type AffiliatePayoutPage = {
  contractVersion: "finance-route-contracts.v1";
  affiliateId: string;
  payoutSettings: {
    payoutsEnabled: boolean;
    payoutProvider: "stripe" | "manual" | "bank_transfer";
    payoutCurrency: string;
    payoutSchedule: "manual" | "monthly" | "threshold";
    payoutThresholdAmount: string | null;
    providerAccount: {
      status: string;
      onboardingStatus: string;
      payoutsEnabled: boolean;
      maskedReference: string | null;
    };
  };
  payouts: AffiliatePayout[];
  total: number;
  limit: number;
  offset: number;
};

export type AffiliatePayoutDetail = AffiliatePayout & {
  maskedDestination: string | null;
  maskedProviderReference: string | null;
  includedEarnings: Array<{
    earningEntryId: string;
    propertyId: string;
    bookingReference: string;
    agreementId: string;
    recordedAt: string;
    currency: string;
    currencyMinorUnit: number;
    commissionMinor: string;
    adjustmentMinor: string;
    appliedMinor: string;
  }>;
};

export const getAffiliatePayouts = (
  query: { limit: number; offset: number },
  signal?: AbortSignal,
) =>
  targetApiClient.get<AffiliatePayoutPage>(
    `/api/marketplace/affiliate-payouts?limit=${query.limit}&offset=${query.offset}`,
    { signal },
  );

export const getAffiliatePayout = (payoutId: string, currency: string, signal?: AbortSignal) =>
  targetApiClient.get<{ payout: AffiliatePayoutDetail }>(
    `/api/marketplace/affiliate-payouts/${encodeURIComponent(payoutId)}?currency=${encodeURIComponent(currency)}`,
    { signal },
  );

export const downloadAffiliatePayoutStatement = (payoutId: string, currency: string) =>
  targetApiClient.getBlob(
    `/api/marketplace/affiliate-payouts/${encodeURIComponent(payoutId)}/statement?currency=${encodeURIComponent(currency)}`,
  );

export const startAffiliateStripeSetup = (country: string, commandId: string) =>
  targetApiClient.post<{ onboardingUrl: string }>("/api/marketplace/affiliate-payouts/stripe", {
    commandId,
    idempotencyKey: commandId,
    country,
  });
