import {
  resolveFinanceAffiliatePercentagePolicy,
  type FinanceAffiliatePercentagePolicyRecord,
} from "./affiliatePercentagePolicy.js";

export type AffiliateEarningScope = Readonly<{
  propertyId: string;
  creatorProfileId: string;
  agreementId: string;
  policyVersionId: string;
  bookingId: string;
  stayItemId: string;
  currency: string;
  currencyMinorUnit: number;
  rounding: "half_up";
}>;
export type AffiliateEarningSnapshot = Readonly<{
  scope: AffiliateEarningScope;
  commissionMinor: string;
}>;
type Input = Readonly<{
  scope: AffiliateEarningScope;
  policy: FinanceAffiliatePercentagePolicyRecord | null;
  evidence: Readonly<{
    status: "verified" | "incomplete" | "conflicting";
    stay: "completed" | "cancelled" | "no_show" | "unknown";
    // Already net of allocated discounts/refunds. Never pass gross totals or penalties.
    netAccommodationMinor: string | null;
    references: readonly string[];
  }>;
  previous: AffiliateEarningSnapshot | null;
}>;
export type AffiliateEarningResult =
  | { status: "pending"; reason: "incomplete_evidence" | "policy_unavailable" }
  | {
      status: "needs_review";
      reason: "invalid_input" | "conflicting_evidence" | "previous_scope_mismatch";
    }
  | {
      status: "calculated";
      snapshot: AffiliateEarningSnapshot;
      adjustmentMinor: string;
      evidenceReferences: readonly string[];
    };
const scopeKeys = [
  "propertyId",
  "creatorProfileId",
  "agreementId",
  "policyVersionId",
  "bookingId",
  "stayItemId",
  "currency",
  "currencyMinorUnit",
  "rounding",
] as const;
const reference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
// Bounded canonical integers in minor units. BigInt avoids floating-point loss.
const amount = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,29})$/.test(value);
const validScope = (scope: AffiliateEarningScope) =>
  scopeKeys.slice(0, 6).every((key) => reference(scope[key])) &&
  /^[A-Z]{3}$/.test(scope.currency) &&
  Number.isInteger(scope.currencyMinorUnit) &&
  scope.currencyMinorUnit >= 0 &&
  scope.currencyMinorUnit <= 9 &&
  scope.rounding === "half_up";

/** Pure internal arithmetic over trusted, scoped evidence. Caller owns authorization,
 * attribution, evidence classification, currency support, ordering and durable deduplication.
 * A calculated amount is not payout eligibility or a transfer instruction.
 */
export function calculateAffiliateEarning(input: Input): AffiliateEarningResult {
  const { scope, evidence, previous } = input;
  const review = (
    reason: "invalid_input" | "conflicting_evidence" | "previous_scope_mismatch",
  ): AffiliateEarningResult => ({ status: "needs_review", reason });
  if (
    !validScope(scope) ||
    (previous && (!validScope(previous.scope) || !amount(previous.commissionMinor)))
  )
    return review("invalid_input");
  if (previous && scopeKeys.some((key) => previous.scope[key] !== scope[key]))
    return review("previous_scope_mismatch");
  if (evidence.status === "conflicting") return review("conflicting_evidence");
  if (evidence.status === "incomplete") return { status: "pending", reason: "incomplete_evidence" };
  if (
    evidence.status !== "verified" ||
    !["completed", "cancelled", "no_show", "unknown"].includes(evidence.stay) ||
    !Array.isArray(evidence.references) ||
    evidence.references.length > 100 ||
    !evidence.references.every(reference)
  )
    return review("invalid_input");
  if (evidence.stay === "unknown" || !evidence.references.length)
    return { status: "pending", reason: "incomplete_evidence" };
  const policy = resolveFinanceAffiliatePercentagePolicy(input.policy, {
    propertyId: scope.propertyId,
    policyVersionId: scope.policyVersionId,
  });
  if (policy.status !== "available") return { status: "pending", reason: "policy_unavailable" };
  if (evidence.netAccommodationMinor !== null && !amount(evidence.netAccommodationMinor))
    return review("invalid_input");
  if (evidence.stay === "completed" && evidence.netAccommodationMinor === null)
    return { status: "pending", reason: "incomplete_evidence" };
  // Non-consumed items can carry penalties, but cannot carry positive consumed accommodation.
  if (
    evidence.stay !== "completed" &&
    evidence.netAccommodationMinor !== null &&
    evidence.netAccommodationMinor !== "0"
  )
    return review("conflicting_evidence");
  const net = evidence.stay === "completed" ? BigInt(evidence.netAccommodationMinor!) : 0n;
  const commission = (net * BigInt(policy.policy.rateBasisPoints) + 5000n) / 10000n;
  return {
    status: "calculated",
    snapshot: { scope: { ...scope }, commissionMinor: commission.toString() },
    adjustmentMinor: (commission - BigInt(previous?.commissionMinor ?? "0")).toString(),
    evidenceReferences: [...evidence.references],
  };
}
