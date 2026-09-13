import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  lockBookingPricingOfferTerms,
  lockBookingPricingTermsSource,
} from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsPricingRoomScope } from "./pmsPricingRoomScope.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { lockReplacementChargeDeclaration } from "./replacementChargeDeclarations.js";
import { readCurrentPricingSnapshot } from "./replacementPricingSnapshot.js";

/** Internal Booking composition boundary; never serialize this whole result publicly.
 * Caller owns a READ COMMITTED transaction, retaining locks through consumption.
 * Checks the complete publication, including linked ancestors. Stay restrictions,
 * physical inventory, promotions/extras/FX and quote acceptance remain separate. */
export async function lockPublicPricingPublication(client: PoolClient, slug: unknown) {
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return null;
  const { propertyId } = scope;
  const stored = await readCurrentPricingSnapshot(client, propertyId);
  if (
    !stored ||
    !stored.rooms.length ||
    Object.keys(stored.sources).length !== 3 ||
    !["room", "terms", "finance"].every((key) => typeof stored.sources[key] === "string") ||
    Object.keys(stored.ownerReferences).length !== 2 ||
    !["finance", "charges"].every((key) => typeof stored.ownerReferences[key] === "string")
  )
    return null;
  const room = await lockPmsReplacementPricingRoomSource(client, propertyId);
  if (!room || stored.sources.room !== room) return null;
  for (const configuration of stored.rooms)
    if (!(await lockPmsPricingRoomScope(client, propertyId, configuration.roomTypeId))) return null;
  const references = stored.rooms.flatMap((r) =>
    r.offers.map((o) => ({
      roomTypeId: r.roomTypeId,
      offerId: o.id,
      revision: o.termsRevision,
    })),
  );
  const terms = await lockBookingPricingOfferTerms(client, propertyId, references);
  const termsSource = await lockBookingPricingTermsSource(client, propertyId);
  if (!terms || !termsSource || stored.sources.terms !== termsSource) return null;
  const financeSource = await lockFinanceReplacementPricingSource(client, propertyId);
  if (!financeSource || stored.sources.finance !== financeSource) return null;
  const finance = await lockFinanceReplacementPricingReadiness(client, {
    propertyId,
    currency: stored.currency,
    pricingRevision: stored.revision,
    terms,
    expectedEvidenceId: stored.ownerReferences.finance,
  });
  if (finance.kind !== "ready") return null;
  const snapshot = {
    currency: stored.currency,
    rooms: stored.rooms,
    ownerReferences: stored.ownerReferences,
  };
  const charges = await lockReplacementChargeDeclaration(
    client,
    propertyId,
    stored.ownerReferences.charges!,
    snapshot,
    stored.sources,
  );
  if (!charges) return null;
  // Source locks can wait: recheck time-limited public access after those reads.
  if (!(await lockPublicPricingAuthority(client, slug))) return null;
  const pmsSourceRevision =
    "booking.pms.publication.v2:" +
    createHash("sha256")
      .update(
        JSON.stringify({
          propertyId,
          organizationId: scope.organizationId,
          authorityRevision: scope.authorityRevision,
          pricingRevision: stored.revision,
          room,
          terms: termsSource,
          finance: financeSource,
        }),
      )
      .digest("hex");
  return { scope, publication: stored, terms, finance, charges, pmsSourceRevision };
}
