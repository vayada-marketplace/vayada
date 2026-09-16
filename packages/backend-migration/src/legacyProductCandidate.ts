/**
 * Source-policy preflight only, NOT an authorization decision.
 * Candidates still require immutable evidence, current identity/ownership,
 * approvals, entitlements and the product-scoped runtime checks in VAY-2017.
 * No caller may use this result to grant access or transition a binding.
 */
export type LegacyProductCandidateInput = {
  product: "pms" | "marketplace";
  sourceOwnerId: string;
  targetOwnerId: string;
  sourcePropertyId: string;
  linkedLegacyPropertyId: string;
  sourceUserStatus: string | null;
  /** Normalized PMS hotel lifecycle or Marketplace approval, never channel connectivity. */
  sourceProductStatus: string | null;
  ownershipMatchCount: number;
  currentRestrictionCheck: "clear" | "denied" | "unknown";
  protectedFixture: boolean;
};

export type LegacyProductCandidateResult =
  | { outcome: "requires_evidence_verification" }
  | {
      outcome: "blocked";
      reason:
        | "protected_fixture"
        | "ownership_not_exact"
        | "current_restrictions_not_clear"
        | "source_user_not_eligible"
        | "source_product_not_eligible";
    };

export function evaluateLegacyProductCandidate(
  input: LegacyProductCandidateInput,
): LegacyProductCandidateResult {
  if (input.protectedFixture !== false) return { outcome: "blocked", reason: "protected_fixture" };
  if (
    input.ownershipMatchCount !== 1 ||
    !input.sourceOwnerId?.trim() ||
    !input.sourcePropertyId?.trim() ||
    input.sourceOwnerId !== input.targetOwnerId ||
    input.sourcePropertyId !== input.linkedLegacyPropertyId
  )
    return { outcome: "blocked", reason: "ownership_not_exact" };
  if (input.currentRestrictionCheck !== "clear")
    return { outcome: "blocked", reason: "current_restrictions_not_clear" };

  // Unknown statuses fail closed, even if a legacy gate happened to admit them.
  const sourceUserEligible =
    input.sourceUserStatus === "verified" ||
    (input.product === "pms" && input.sourceUserStatus === "pending");
  if (!sourceUserEligible) return { outcome: "blocked", reason: "source_user_not_eligible" };

  const sourceProductEligible =
    (input.product === "pms" && input.sourceProductStatus === "active") ||
    (input.product === "marketplace" && input.sourceProductStatus === "verified");
  if (!sourceProductEligible) return { outcome: "blocked", reason: "source_product_not_eligible" };

  return { outcome: "requires_evidence_verification" };
}
