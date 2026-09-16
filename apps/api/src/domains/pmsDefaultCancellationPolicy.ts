import type { FlexibleCancellationTerms } from "@vayada/domain-pms";

// The fixed default offered by the legacy room form, expressed as owner terms.
export const DEFAULT_FLEXIBLE_CANCELLATION_POLICY = {
  type: "free_until_days_before_arrival",
  freeCancellationDeadlineDays: 7,
  afterDeadlinePenalty: "full_booking_amount",
  noShowPenalty: "full_booking_amount",
  text: "Free until 7 days before",
  flexibleCancellationType: "free",
  partialRefundCancelWindowDays: 30,
  partialRefundAmountPercent: 50,
  partialRefundTiers: [],
} satisfies FlexibleCancellationTerms;
