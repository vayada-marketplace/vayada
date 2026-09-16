import type { PoolClient } from "pg";
import { lockPublicPricingComponents } from "./publicPricingComponents.js";
import { lockCurrentFixedCharges } from "./currentFixedCharges.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { composeReplacementSettlementAmounts } from "./replacementSettlementAmounts.js";

/** Internal current amounts only. No payment schedule, quote acceptance or inventory claim. */
export async function lockPublicPricingChargeTotals(
  client: PoolClient,
  slug: unknown,
  input: unknown,
) {
  const components = await lockPublicPricingComponents(client, slug, input);
  if (!components) return null;
  const coverage = components.room.owner.charges;
  if (coverage.declaration !== "fixed_charge_policy") return null;
  const charges = await lockCurrentFixedCharges(client, components.stay);
  if (
    !charges ||
    charges.policyRevision !== coverage.policyRevision ||
    charges.requestKey !== components.requestKey
  )
    return null;
  // Use the shared charge arithmetic; discard its neutral deferred schedule.
  // Selected payment method and per-rate execution eligibility are separate owners.
  const amounts = composeReplacementSettlementAmounts({
    subtotalMinor: components.subtotalMinor,
    charges: charges.charges.map(({ id, amountMinor, included, collect, basisEvidenceId }) => ({
      id,
      amountMinor,
      included,
      collect,
      basisEvidenceId,
    })),
    payment: { kind: "pay_at_property" },
  });
  if (!amounts) return null;
  const scope = await lockPublicPricingAuthority(client, slug),
    previous = components.room.owner.scope;
  if (
    !scope ||
    scope.propertyId !== previous.propertyId ||
    scope.organizationId !== previous.organizationId ||
    scope.authorityRevision !== previous.authorityRevision
  )
    return null;
  const date = (
    await client.query("SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS date", [
      components.lastMinute.propertyTimeZone,
    ])
  ).rows[0].date;
  if (date !== components.lastMinute.bookingLocalDate) return null;
  return {
    kind: "pricing_charge_totals" as const,
    evaluatorVersion: "booking.charge-totals.v1" as const,
    stay: components.stay,
    requestKey: components.requestKey,
    components,
    charges,
    subtotalMinor: components.subtotalMinor,
    totalMinor: amounts.totalMinor,
    includedChargeMinor: amounts.includedChargeMinor,
    additionalChargeMinor: amounts.additionalChargeMinor,
    propertyCollectedMinor: amounts.propertyCollectedMinor,
    onlineCollectibleMinor: amounts.onlineCollectibleMinor,
    componentSources: { ...components.componentSources, charges: charges.sourceRevision },
  };
}
