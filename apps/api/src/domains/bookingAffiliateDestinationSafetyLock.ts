import type pg from "pg";
import { affiliateDestinationSafetyLockKey } from "@vayada/domain-booking";

export { affiliateDestinationSafetyLockKey } from "@vayada/domain-booking";

export async function lockAffiliateDestinationSafety(
  client: Pick<pg.PoolClient, "query">,
  propertyId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    affiliateDestinationSafetyLockKey(propertyId),
  ]);
}
