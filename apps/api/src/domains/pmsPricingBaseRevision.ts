import type { PoolClient } from "pg";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

/** PMS-owned base check for authorized Booking staging, in the caller's transaction. */
export async function lockPmsPricingBaseRevision(client: PoolClient, propertyId: string, expected: number): Promise<boolean> {
  await lockPmsInventoryMutationScope(client, propertyId);
  const row = (await client.query("SELECT revision FROM pms.pricing_v2_heads WHERE property_id=$1 FOR SHARE", [propertyId])).rows[0];
  return (row?.revision ?? 0) === expected;
}
