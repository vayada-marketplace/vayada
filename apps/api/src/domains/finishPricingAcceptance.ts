import type { PoolClient } from "pg";
import type { lockFinancePricingAcceptanceTerms } from "./financePricingAcceptanceTerms.js";
import { finishCurrentQuoteAcceptanceTime } from "./currentQuoteAcceptanceTime.js";

/** Final combined gate for the future writer. Both inputs must come from this
 * retained READ COMMITTED transaction before mutations. Stage ALL blocking writes
 * first; any failure requires full rollback. This returns a timestamp, not a booking. */
export async function finishPricingAcceptance(
  client: PoolClient,
  slug: unknown,
  current: Parameters<typeof finishCurrentQuoteAcceptanceTime>[2],
  finance: NonNullable<Awaited<ReturnType<typeof lockFinancePricingAcceptanceTerms>>>,
) {
  const fail = (): never => {
    throw new Error("Booking acceptance expired or unavailable");
  };
  if (
    !finance ||
    finance.scope.propertyId !== current.scope.propertyId ||
    finance.scope.organizationId !== current.scope.organizationId ||
    finance.scope.authorityRevision !== current.scope.authorityRevision
  )
    return fail();
  const captured = Date.parse(finance.financeTermsCapturedAt);
  const expires = finance.validUntil === null ? Infinity : Date.parse(finance.validUntil);
  if (!Number.isFinite(captured) || !(expires > captured)) return fail();
  // This reads clock_timestamp only after all quote-owner and authority waits.
  const checkedAt = await finishCurrentQuoteAcceptanceTime(client, slug, current);
  const now = Date.parse(checkedAt);
  if (!Number.isFinite(now) || now < captured || now >= expires) return fail();
  return checkedAt;
}
