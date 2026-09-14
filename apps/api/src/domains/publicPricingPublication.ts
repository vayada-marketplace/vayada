import type { PoolClient } from "pg";
import { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";

/** Guest-facing composition boundary. Caller retains READ COMMITTED locks.
 * Public visibility is mandatory both before and after potentially waiting on owners. */
export async function lockPublicPricingPublication(client: PoolClient, slug: unknown) {
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return null;
  const current = await lockCurrentPricingPublication(client, scope);
  if (!current) return null;
  const confirmed = await lockPublicPricingAuthority(client, slug);
  if (
    !confirmed ||
    confirmed.propertyId !== current.scope.propertyId ||
    confirmed.organizationId !== current.scope.organizationId ||
    confirmed.authorityRevision !== current.scope.authorityRevision
  )
    return null;
  return current;
}
