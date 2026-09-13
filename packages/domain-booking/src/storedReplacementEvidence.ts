import {
  isMinorAmount,
  isPositiveMinor,
  pricingCurrencyScale,
  pricingKeys,
  pricingObject,
} from "@vayada/domain-pms";
import { parseBookingPricingOfferTerms } from "./replacementPricingBrowser.js";
import type { ReplacementPricingEvidence } from "./replacementPricingEvidence.js";

const text = (v: unknown): v is string =>
  typeof v === "string" && v === v.trim() && v.length > 0 && v.length <= 200;
const shape = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  pricingObject(v) && pricingKeys(v, keys);
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
const timestamp = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const revisionKeys = ["pms", "terms", "promotions", "addons", "charges", "finance", "fx"];

/** Structural decoder for stored JSON, not arithmetic validation or authorization.
 * The complete stored quote decoder additionally checks stay binding and conservation. */
export function parseStoredReplacementEvidence(value: unknown): ReplacementPricingEvidence | null {
  if (
    !shape(value, [
      "version",
      "requestKey",
      "revisions",
      "currency",
      "issuedAt",
      "expiresAt",
      "lines",
      "totalMinor",
      "dueNowMinor",
      "dueLaterMinor",
      "terms",
      "fx",
      "paymentCapabilityEvidenceId",
      "mandatoryChargeEvidenceId",
    ]) ||
    value.version !== "pricing.v2" ||
    typeof value.requestKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.requestKey) ||
    !shape(value.revisions, revisionKeys) ||
    !Object.values(value.revisions).every(text) ||
    typeof value.currency !== "string" ||
    pricingCurrencyScale(value.currency) === null ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.expiresAt) ||
    ![value.totalMinor, value.dueNowMinor, value.dueLaterMinor].every(isMinorAmount) ||
    !text(value.paymentCapabilityEvidenceId) ||
    !text(value.mandatoryChargeEvidenceId) ||
    !list(value.lines, 100000) ||
    !list(value.terms, 99) ||
    !list(value.fx, 99)
  )
    return null;
  for (const line of value.lines) {
    if (
      !shape(line, ["id", "selectionId", "kind", "amountMinor"]) ||
      !text(line.id) ||
      !(line.selectionId === null || text(line.selectionId)) ||
      !isMinorAmount(line.amountMinor) ||
      typeof line.kind !== "string" ||
      !["room", "meal", "addon", "charge", "discount"].includes(line.kind)
    )
      return null;
  }
  if (!Array.from(value.terms).every((term) => parseBookingPricingOfferTerms(term) !== null))
    return null;
  const fxIds = new Set<string>();
  for (const fx of value.fx) {
    if (
      !shape(fx, ["id", "from", "to", "numerator", "denominator", "observedAt", "expiresAt"]) ||
      !text(fx.id) ||
      fxIds.has(fx.id) ||
      typeof fx.from !== "string" ||
      typeof fx.to !== "string" ||
      pricingCurrencyScale(fx.from) === null ||
      pricingCurrencyScale(fx.to) === null ||
      !isPositiveMinor(fx.numerator) ||
      !isPositiveMinor(fx.denominator) ||
      !timestamp(fx.observedAt) ||
      !timestamp(fx.expiresAt)
    )
      return null;
    fxIds.add(fx.id);
  }
  return value as ReplacementPricingEvidence;
}
