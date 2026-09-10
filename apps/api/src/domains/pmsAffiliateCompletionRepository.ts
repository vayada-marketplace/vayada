import pg from "pg";
import { readPmsAffiliateCompletionEvidence } from "./pmsAffiliateCompletionEvidence.js";
export function createPgPmsAffiliateCompletionRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    read: (input: Parameters<typeof readPmsAffiliateCompletionEvidence>[1]) =>
      readPmsAffiliateCompletionEvidence(pool, input),
    close: () => pool.end(),
  };
}
export type AffiliateCompletionRepository = ReturnType<
  typeof createPgPmsAffiliateCompletionRepository
>;
