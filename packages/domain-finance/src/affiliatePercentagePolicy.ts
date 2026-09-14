export const FINANCE_AFFILIATE_PERCENTAGE_POLICY_VERSION =
  "finance-affiliate-percentage-policy.v1" as const;

export type FinanceAffiliatePercentagePolicy = Readonly<{
  contractVersion: typeof FINANCE_AFFILIATE_PERCENTAGE_POLICY_VERSION;
  model: "percentage";
  revenueBasis: "accommodation_excluding_taxes_and_extras";
  eligibility: "verified_completion";
  rateBasisPoints: number;
  percentageRate: string;
}>;

/** Hotel input, not authorization or publication. No rate is inferred. */
export function parseFinanceAffiliatePercentagePolicy(
  input: unknown,
): FinanceAffiliatePercentagePolicy | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 1 || keys[0] !== "percentageRate") return null;
  // Read data only; do not invoke caller-provided accessors.
  const descriptor = Object.getOwnPropertyDescriptor(input, "percentageRate");
  const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d?|100)(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const rateBasisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (rateBasisPoints > 10000) return null;
  return Object.freeze({
    contractVersion: FINANCE_AFFILIATE_PERCENTAGE_POLICY_VERSION,
    model: "percentage",
    revenueBasis: "accommodation_excluding_taxes_and_extras",
    eligibility: "verified_completion",
    rateBasisPoints,
    percentageRate: `${whole}.${fraction.padEnd(2, "0")}`,
  });
}

export type FinanceAffiliatePercentagePolicyRecord = Readonly<{
  policyVersionId: string;
  propertyId: string;
  approvalStatus: "draft" | "approved";
  policy: FinanceAffiliatePercentagePolicy;
}>;

export type FinanceAffiliatePolicyResolution =
  | {
      status: "available";
      policyVersionId: string;
      propertyId: string;
      policy: FinanceAffiliatePercentagePolicy;
    }
  | {
      status: "unavailable";
      reason: "not_found" | "scope_mismatch" | "not_approved" | "invalid_policy";
    };

/** Select an exact persisted version supplied by Finance's repository, never a replacement version. */
export function resolveFinanceAffiliatePercentagePolicy(
  record: FinanceAffiliatePercentagePolicyRecord | null,
  request: { propertyId: string; policyVersionId: string },
): FinanceAffiliatePolicyResolution {
  const unavailable = (
    reason: Extract<FinanceAffiliatePolicyResolution, { status: "unavailable" }>["reason"],
  ): FinanceAffiliatePolicyResolution => ({ status: "unavailable", reason });
  if (!record || record.policyVersionId !== request.policyVersionId)
    return unavailable("not_found");
  if (record.propertyId !== request.propertyId) return unavailable("scope_mismatch");
  if (record.approvalStatus !== "approved") return unavailable("not_approved");
  const parsed = parseFinanceAffiliatePercentagePolicy({
    percentageRate: record.policy.percentageRate,
  });
  if (
    !parsed ||
    record.policy.contractVersion !== parsed.contractVersion ||
    record.policy.model !== parsed.model ||
    record.policy.revenueBasis !== parsed.revenueBasis ||
    record.policy.eligibility !== parsed.eligibility ||
    record.policy.rateBasisPoints !== parsed.rateBasisPoints
  )
    return unavailable("invalid_policy");
  return {
    status: "available",
    propertyId: record.propertyId,
    policyVersionId: record.policyVersionId,
    policy: parsed,
  };
}
