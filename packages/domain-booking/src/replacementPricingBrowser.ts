import type { ReplacementOfferTerms } from "./replacementPricingEvidence.js";
import { parseFlexibleCancellationTerms, pricingInteger, pricingKeys, pricingObject } from "@vayada/domain-pms/replacement-pricing";
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v === v.trim() && v.length > 0 && v.length <= 200;
export type { ReplacementOfferTerms } from "./replacementPricingEvidence.js";

/** Strict owner boundary; no defaults that silently change a saved policy. */
export function parseBookingPricingOfferTerms(value: unknown): ReplacementOfferTerms | null {
  if (!pricingObject(value) || !pricingKeys(value, ["roomTypeId", "offerId", "revision", "cancellation", "payment"]) ||
      !uuid(value.roomTypeId) || !text(value.offerId) || !uuid(value.revision) || !pricingObject(value.cancellation) || !pricingObject(value.payment)) return null;
  const c = value.cancellation, p = value.payment;
  if (!(c.kind === "non_refundable" && pricingKeys(c, ["kind"])) &&
      !(c.kind === "flexible" && pricingKeys(c, ["kind", "terms"]) && parseFlexibleCancellationTerms(c.terms))) return null;
  if (!(p.kind === "full" && pricingKeys(p, ["kind"])) &&
      !(p.kind === "deposit" && pricingKeys(p, ["kind", "basisPoints", "balanceDaysBeforeArrival"]) &&
        pricingInteger(p.basisPoints, 1) && p.basisPoints <= 10000 && pricingInteger(p.balanceDaysBeforeArrival))) return null;
  return structuredClone({ ...value, roomTypeId: value.roomTypeId.toLowerCase(), revision: value.revision.toLowerCase() }) as ReplacementOfferTerms;
}
