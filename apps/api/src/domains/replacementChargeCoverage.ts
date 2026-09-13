import type { PoolClient } from "pg";
import { lockCurrentFixedChargePolicy } from "./currentFixedCharges.js";
import {
  lockReplacementChargeDeclaration,
  replacementChargeFingerprint,
} from "./replacementChargeDeclarations.js";
import type { PricingStorageSnapshot, PricingStorageSources } from "./replacementPricingStore.js";

/** Explicit publication adoption of a current complete fixed policy, or legacy inclusion.
 * Caller owns authorization and transaction. No inferred rule or tax-compliance coverage. */
export async function lockReplacementChargeCoverage(
  client: PoolClient,
  propertyId: string,
  reference: string,
  snapshot: PricingStorageSnapshot,
  sources: PricingStorageSources,
) {
  const prefix = "booking.fixed-charge-policy.v1:";
  if (!reference.startsWith(prefix))
    return lockReplacementChargeDeclaration(client, propertyId, reference, snapshot, sources);
  const fingerprint = replacementChargeFingerprint(propertyId, snapshot, sources);
  if (!fingerprint) return null;
  const current = await lockCurrentFixedChargePolicy(client, propertyId);
  if (
    !current ||
    reference !== prefix + current.revision ||
    current.policy.currency !== snapshot.currency
  )
    return null;
  return {
    id: reference,
    fingerprint,
    declaration: "fixed_charge_policy" as const,
    policyRevision: current.revision,
  };
}
export type ReplacementChargeCoverage = NonNullable<
  Awaited<ReturnType<typeof lockReplacementChargeCoverage>>
>;
