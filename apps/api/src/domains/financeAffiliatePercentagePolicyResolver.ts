import {
  parseFinanceAffiliatePercentagePolicy,
  resolveFinanceAffiliatePercentagePolicy,
  type FinanceAffiliatePolicyResolution,
} from "@vayada/domain-finance";
import type pg from "pg";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal Finance read. Callers authorize the property; availability covers only commission policy. */
export async function resolvePgFinanceAffiliatePercentagePolicy(
  database: Pick<pg.Pool, "query">,
  request: { propertyId: string; policyVersionId: string },
): Promise<FinanceAffiliatePolicyResolution> {
  if (!uuid.test(request.propertyId) || !uuid.test(request.policyVersionId))
    return { status: "unavailable", reason: "not_found" };
  const scope = {
    propertyId: request.propertyId.toLowerCase(),
    policyVersionId: request.policyVersionId.toLowerCase(),
  };
  const result = await database.query(
    `SELECT policy.id, policy.property_id, policy.contract_version, policy.model,
            policy.revenue_basis, policy.eligibility, policy.rate_basis_points,
            approval.policy_version_id AS approved_id
     FROM finance.affiliate_percentage_policy_versions policy
     LEFT JOIN finance.affiliate_percentage_policy_approvals approval
       ON approval.policy_version_id=policy.id AND approval.property_id=policy.property_id
       AND approval.approved_by_organization_id=policy.created_by_organization_id
     WHERE policy.id=$1 AND policy.property_id=$2`,
    [scope.policyVersionId, scope.propertyId],
  );
  const row = result.rows[0];
  if (!row) return resolveFinanceAffiliatePercentagePolicy(null, scope);
  const rate: unknown = row.rate_basis_points;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0 || rate > 10000)
    return { status: "unavailable", reason: "invalid_policy" };
  const policy = parseFinanceAffiliatePercentagePolicy({
    percentageRate: `${Math.floor(rate / 100)}.${String(rate % 100).padStart(2, "0")}`,
  });
  if (
    !policy ||
    row.contract_version !== policy.contractVersion ||
    row.model !== policy.model ||
    row.revenue_basis !== policy.revenueBasis ||
    row.eligibility !== policy.eligibility
  )
    return { status: "unavailable", reason: "invalid_policy" };
  return resolveFinanceAffiliatePercentagePolicy(
    {
      policyVersionId: row.id,
      propertyId: row.property_id,
      approvalStatus: row.approved_id ? "approved" : "draft",
      policy,
    },
    scope,
  );
}
