import {
  isMinorAmount,
  isPositiveMinor,
  pricingDate,
  pricingInteger,
  pricingKeys,
  pricingObject,
  type PricedRoomNight,
  type PricingMeal,
} from "@vayada/domain-pms";
import { parseStoredReplacementEvidence } from "./storedReplacementEvidence.js";
import {
  parsePublicPricingSelection,
  PUBLIC_PRICING_SELECTION_VERSION,
} from "./publicPricingSelection.js";
import {
  parseReplacementStay,
  replacementEvidenceStatus,
  type ReplacementPricingEvidence,
  type ReplacementStay,
  type PricingSourceRevisions,
} from "./replacementPricingEvidence.js";

export type StoredPricingRoom = Readonly<{
  selectionId: string;
  configurationRevision: number;
  termsRevisions: Readonly<Record<string, string>>;
  mealPlan: PricingMeal["kind"];
  nights: readonly PricedRoomNight[];
}>;
export type StoredPricingQuote = Readonly<{
  version: "stored-pricing-quote.v1";
  quoteId: string;
  evaluatorVersion: string;
  paymentMethod: string;
  stay: ReplacementStay;
  evidence: ReplacementPricingEvidence;
  rooms: readonly StoredPricingRoom[];
}>;
const text = (v: unknown): v is string =>
  typeof v === "string" && v === v.trim() && v.length > 0 && v.length <= 200;
const shape = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  pricingObject(v) && pricingKeys(v, keys);
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
/** Decode server-stored JSON. Structural validity is NOT public quote authority or payment readiness.
 * Historical reads validate at issuance, never against today's clock or current owner revisions. */
export function parseStoredPricingQuote(value: unknown): StoredPricingQuote | null {
  if (
    !shape(value, [
      "version",
      "quoteId",
      "evaluatorVersion",
      "paymentMethod",
      "stay",
      "evidence",
      "rooms",
    ]) ||
    value.version !== "stored-pricing-quote.v1" ||
    !text(value.quoteId) ||
    !text(value.evaluatorVersion) ||
    !text(value.paymentMethod) ||
    !pricingObject(value.stay) ||
    !list(value.stay.rooms, 99) ||
    !list(value.stay.addons, 99) ||
    !list(value.rooms, 99)
  )
    return null;
  const rawStay = value.stay;
  if (!Array.from(rawStay.rooms as unknown[]).every(pricingObject)) return null;
  // Reuse the public resource ceilings without treating internal identifiers as public authority.
  if (
    !parsePublicPricingSelection({
      version: PUBLIC_PRICING_SELECTION_VERSION,
      checkIn: rawStay.checkIn,
      checkOut: rawStay.checkOut,
      currency: rawStay.currency,
      promoCode: rawStay.promoCode,
      addons: rawStay.addons,
      rooms: (rawStay.rooms as Record<string, unknown>[]).map((room) => ({
        selectionId: room.selectionId,
        publicOfferKey: room.offerId,
        guests: room.guests,
      })),
    })
  )
    return null;
  const stay = parseReplacementStay(rawStay),
    evidence = parseStoredReplacementEvidence(value.evidence);
  if (
    !stay ||
    !text(stay.propertyId) ||
    !evidence ||
    replacementEvidenceStatus(evidence, stay, evidence.revisions, new Date(evidence.issuedAt)) !==
      "current" ||
    value.rooms.length !== stay.rooms.length
  )
    return null;
  const selections = new Set<string>();
  for (const room of value.rooms) {
    if (
      !shape(room, [
        "selectionId",
        "configurationRevision",
        "termsRevisions",
        "mealPlan",
        "nights",
      ]) ||
      !text(room.selectionId) ||
      selections.has(room.selectionId) ||
      !pricingInteger(room.configurationRevision, 1) ||
      !text(room.mealPlan) ||
      !["room_only", "breakfast", "half_board", "full_board", "all_inclusive"].includes(
        room.mealPlan,
      ) ||
      !pricingObject(room.termsRevisions) ||
      Object.keys(room.termsRevisions).length > 100 ||
      !Object.entries(room.termsRevisions).every(([id, revision]) => text(id) && text(revision)) ||
      !list(room.nights, 366)
    )
      return null;
    const selected = stay.rooms.find((r) => r.selectionId === room.selectionId);
    if (!selected || !text(selected.roomTypeId)) return null;
    const terms = evidence.terms.find(
      (t) => t.roomTypeId === selected.roomTypeId && t.offerId === selected.offerId,
    )!;
    if (
      !Object.hasOwn(room.termsRevisions, selected.offerId) ||
      room.termsRevisions[selected.offerId] !== terms.revision ||
      room.nights.length !== (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000
    )
      return null;
    let date = Date.parse(stay.checkIn),
      roomTotal = 0n,
      mealTotal = 0n;
    for (const night of room.nights) {
      if (
        !shape(night, ["date", "roomMinor", "mealMinor", "totalMinor", "sources"]) ||
        !pricingDate(night.date) ||
        night.date !== new Date(date).toISOString().slice(0, 10) ||
        !isPositiveMinor(night.roomMinor) ||
        !isMinorAmount(night.mealMinor) ||
        !isMinorAmount(night.totalMinor) ||
        BigInt(night.roomMinor) + BigInt(night.mealMinor) !== BigInt(night.totalMinor) ||
        !list(night.sources, 100) ||
        !night.sources.length
      )
        return null;
      for (const source of night.sources) {
        if (
          !shape(source, ["offerId", "kind"]) ||
          !text(source.offerId) ||
          !Object.hasOwn(room.termsRevisions, source.offerId) ||
          typeof source.kind !== "string" ||
          !["date", "season", "month", "base", "weekday", "linked"].includes(source.kind)
        )
          return null;
      }
      if ((night.sources.at(-1) as { offerId: string }).offerId !== selected.offerId) return null;
      date += 86400000;
      roomTotal += BigInt(night.roomMinor);
      mealTotal += BigInt(night.mealMinor);
    }
    const sum = (kind: "room" | "meal") =>
      evidence.lines
        .filter((line) => line.selectionId === room.selectionId && line.kind === kind)
        .reduce((total, line) => total + BigInt(line.amountMinor), 0n);
    if (
      (room.mealPlan === "room_only" && mealTotal !== 0n) ||
      roomTotal !== sum("room") ||
      mealTotal !== sum("meal") ||
      !isMinorAmount(roomTotal.toString()) ||
      !isMinorAmount(mealTotal.toString())
    )
      return null;
    selections.add(room.selectionId);
  }
  return structuredClone(value) as StoredPricingQuote;
}

/** Fresh acceptance only, after loading and decoding the authorized server-issued quote. */
export function storedPricingQuoteStatus(
  quote: StoredPricingQuote,
  stay: ReplacementStay,
  current: PricingSourceRevisions,
  expected: { evaluatorVersion: string; paymentMethod: string },
  now: Date,
): "current" | "stale" | "invalid" {
  if (
    quote.evaluatorVersion !== expected.evaluatorVersion ||
    quote.paymentMethod !== expected.paymentMethod
  )
    return "stale";
  return replacementEvidenceStatus(quote.evidence, stay, current, now);
}
