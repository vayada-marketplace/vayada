import pg from "pg";
import { saveFinanceAffiliatePercentagePolicyFromMarketplace as save } from "./financeAffiliatePercentagePolicySave.js";
import { approveFinanceAffiliatePercentagePolicyFromMarketplace as approve } from "./financeAffiliatePercentagePolicyApprove.js";
import { resolvePgFinanceAffiliatePercentagePolicy as resolve } from "./financeAffiliatePercentagePolicyResolver.js";

export function createPgFinanceAffiliatePercentagePolicyRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    save: (input: Parameters<typeof save>[1]) => save(pool, input),
    approve: (input: Parameters<typeof approve>[1]) => approve(pool, input),
    resolve: (input: Parameters<typeof resolve>[1]) => resolve(pool, input),
    close: () => pool.end(),
  };
}
export type AffiliatePolicyRepository = ReturnType<
  typeof createPgFinanceAffiliatePercentagePolicyRepository
>;
