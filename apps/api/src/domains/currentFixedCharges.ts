import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { parseReplacementStay } from "@vayada/domain-booking";
import {
  calculateReplacementFixedCharges,
  parseFixedChargePolicy,
} from "./replacementFixedCharges.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
/** Current fixed policy inside a caller-authorized READ COMMITTED transaction. */
export async function lockCurrentFixedChargePolicy(client: PoolClient, propertyId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId))
    return null;
  propertyId = propertyId.toLowerCase();
  await lockPmsInventoryMutationScope(client, propertyId);
  if (
    !(
      await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [
        propertyId,
      ])
    ).rowCount
  )
    return null;
  const current = (
    await client.query(
      `SELECT h.revision,r.policy FROM booking.fixed_charge_heads h
    JOIN booking.fixed_charge_revisions r USING(property_id,revision) WHERE h.property_id=$1 FOR SHARE OF h,r`,
      [propertyId],
    )
  ).rows[0];
  if (!current) return null;
  const policy = parseFixedChargePolicy(current.policy);
  return policy ? { revision: current.revision as string, policy } : null;
}

/** Fixed-rule amounts only; caller provides authorization and retains locks. */
export async function lockCurrentFixedCharges(client: PoolClient, value: unknown) {
  const stay = parseReplacementStay(value);
  if (!stay) return null;
  const propertyId = stay.propertyId.toLowerCase();
  const current = await lockCurrentFixedChargePolicy(client, propertyId);
  if (!current) return null;
  const calculated = calculateReplacementFixedCharges(stay, current.policy);
  if (!calculated) return null;
  const sourceRevision =
    "booking.fixed-charges.v1:" +
    createHash("sha256")
      .update(JSON.stringify([propertyId, current.revision, calculated.policyKey]))
      .digest("hex");
  const basisEvidenceId =
    "booking.current-fixed-charge-basis.v1:" +
    createHash("sha256")
      .update(JSON.stringify([sourceRevision, calculated.requestKey]))
      .digest("hex");
  return {
    ...calculated,
    sourceRevision,
    policyRevision: current.revision as string,
    basisEvidenceId,
    charges: calculated.charges.map((c) => ({ ...c, basisEvidenceId })),
  };
}
