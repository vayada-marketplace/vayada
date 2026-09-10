import type { RequestContext } from "@vayada/backend-auth";
import type { PoolClient } from "pg";
import { lockBookingPricingTermsSource } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { lockReplacementPricingDraftOwners, lockReplacementPricingOfferOwners } from "./replacementPricingOfferOwners.js";
import type { PricingStorageGuard, PricingStorageScope, PricingStorageSources } from "./replacementPricingStore.js";

/** Caller owns the transaction. No proposal/readiness requirements on historical retries. */
export async function lockReplacementPricingSources(client: PoolClient, context: RequestContext | null,
  scope: PricingStorageScope, access: "read" | "manage"): Promise<PricingStorageSources | null> {
  if (!await lockReplacementPricingAuthorization(client, context, scope, access)) return null;
  const room = await lockPmsReplacementPricingRoomSource(client, scope.propertyId);
  const terms = await lockBookingPricingTermsSource(client, scope.propertyId);
  const finance = await lockFinanceReplacementPricingSource(client, scope.propertyId);
  return room && terms && finance ? { room, terms, finance } : null;
}

/** Bind only a trusted server RequestContext. Currency changes remain unavailable
 * until separately owned conversion obligations have a concrete approval path. */
export function createReplacementPricingStorageGuard(context: RequestContext | null): PricingStorageGuard {
  const trustedContext = structuredClone(context);
  return {
    lock: (client, scope, access) => lockReplacementPricingSources(client, trustedContext, scope, access),
    async validate(client, scope, proposed, sources, intent) {
      if (Object.keys(proposed.ownerReferences).some((key) => !["finance", "charges"].includes(key)) ||
          Object.keys(sources).length !== 3 || !["room", "terms", "finance"].every((key) => typeof sources[key] === "string")) return false;
      const result = await (intent === "draft" ? lockReplacementPricingDraftOwners : lockReplacementPricingOfferOwners)
        (client, trustedContext, scope, proposed, sources);
      return result.kind === "verified" || (intent === "draft" && result.kind === "awaiting_charge_confirmation");
    },
    async allowCurrencyChange() { return false; },
  };
}
