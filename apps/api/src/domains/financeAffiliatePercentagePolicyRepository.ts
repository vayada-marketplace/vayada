import pg from "pg";
import { saveFinanceAffiliatePercentagePolicyFromMarketplace as save } from "./financeAffiliatePercentagePolicySave.js";
import { approveFinanceAffiliatePercentagePolicyFromMarketplace as approve } from "./financeAffiliatePercentagePolicyApprove.js";
import { resolvePgFinanceAffiliatePercentagePolicy as resolve } from "./financeAffiliatePercentagePolicyResolver.js";

export function createPgFinanceAffiliatePercentagePolicyRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    async list(propertyId: string, organizationId: string) {
      const result = await pool.query(
        `SELECT policy.id, policy.rate_basis_points AS "rateBasisPoints", policy.recorded_at AS "createdAt",
                approval.policy_version_id IS NOT NULL AS approved
         FROM finance.affiliate_percentage_policy_versions policy
         LEFT JOIN finance.affiliate_percentage_policy_approvals approval
           ON approval.policy_version_id=policy.id AND approval.property_id=policy.property_id
           AND approval.approved_by_organization_id=policy.created_by_organization_id
         WHERE policy.property_id=$1 AND policy.created_by_organization_id=$2
         ORDER BY policy.recorded_at DESC, policy.id DESC LIMIT 20`,
        [propertyId, organizationId],
      );
      return { policies: result.rows };
    },
    save: (input: Parameters<typeof save>[1]) => save(pool, input),
    approve: (input: Parameters<typeof approve>[1]) => approve(pool, input),
    resolve: (input: Parameters<typeof resolve>[1]) => resolve(pool, input),
    close: () => pool.end(),
  };
}
export type AffiliatePolicyRepository = ReturnType<
  typeof createPgFinanceAffiliatePercentagePolicyRepository
>;
