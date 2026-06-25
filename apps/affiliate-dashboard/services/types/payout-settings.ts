export type AffiliatePayoutProvider = "stripe" | "manual" | "bank_transfer";
export type AffiliatePayoutSchedule = "manual" | "monthly" | "threshold";

export interface AffiliatePayoutSettings {
  payoutsEnabled: boolean;
  payoutProvider: AffiliatePayoutProvider;
  payoutCurrency: string;
  payoutSchedule: AffiliatePayoutSchedule;
  payoutThresholdAmount: string | null;
  providerAccount: {
    providerAccountId: string | null;
    provider: AffiliatePayoutProvider | null;
    status: string;
    onboardingStatus: string;
    payoutsEnabled: boolean;
  };
  sourceFreshness: Record<string, unknown>;
}

export interface PayoutSettingsResponse {
  contractVersion: "finance-route-contracts.v1";
  affiliateId: string;
  marketplaceOrganizationId: string | null;
  payoutSettings: AffiliatePayoutSettings;
  commandMeta?: {
    commandId: string;
    idempotencyKey: string;
    sideEffects: string[];
    outboxEvents: string[];
    jobs: unknown[];
  };
}

export interface PayoutSettingsPatchCommand {
  commandId: string;
  idempotencyKey: string;
  payoutsEnabled: boolean;
  payoutProvider: AffiliatePayoutProvider;
  payoutCurrency: string;
  payoutSchedule: AffiliatePayoutSchedule;
  payoutThresholdAmount: string | null;
}
