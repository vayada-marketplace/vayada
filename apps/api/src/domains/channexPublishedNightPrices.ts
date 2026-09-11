import type { Pool } from "pg";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import { prepareChannexAdultNightPrices } from "../integrations/channexNightlyPrices.js";
import { readPublishedPricingForChannexJob } from "./replacementPricingOfferOwners.js";

/** Internal candidates with snapshot evidence, not mapped ARI or a send permit.
 * Delivery must independently establish fresh authority and provider readiness.
 */
export async function preparePublishedChannexNightPrices(
  pool: Pool,
  lease: ChannexPricingJobLeaseInput,
  selection: Readonly<{ roomTypeId: string; offerId: string; date: string }>,
) {
  const { roomTypeId, offerId, date } = selection;
  const evidence = await readPublishedPricingForChannexJob(pool, lease);
  if (evidence.kind !== "available") return evidence;
  const room = evidence.publication.rooms.find((room) => room.roomTypeId === roomTypeId);
  if (!room || !room.offers.some((offer) => offer.id === offerId))
    return { kind: "unavailable" as const, reason: "selection_unavailable" };
  const expectedTermsRevisions = Object.fromEntries(
    evidence.owners.terms
      .filter((terms) => terms.roomTypeId === roomTypeId)
      .map((terms) => [terms.offerId, terms.revision]),
  );
  const result = prepareChannexAdultNightPrices(room, {
    propertyId: evidence.authority.lease.propertyId,
    roomTypeId,
    offerId,
    date,
    expectedRevision: evidence.publication.revision,
    expectedTermsRevisions,
  });
  if (result.kind !== "prepared") return result;
  return { kind: "prepared" as const, evidence, candidates: result.candidates };
}
