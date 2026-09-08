import { createHash } from "node:crypto";
import { isMinorAmount, isPositiveMinor, pricingCurrencyScale, pricingDate, pricingInteger,
  pricingKeys, pricingObject, type PricingConfiguration, type PricingGuests } from "@vayada/domain-pms";

export type ReplacementStay = Readonly<{
  propertyId: string; checkIn: string; checkOut: string; currency: string;
  rooms: readonly Readonly<{ selectionId: string; roomTypeId: string; offerId: string; guests: PricingGuests }>[];
  addons: readonly Readonly<{ id: string; quantity: number }>[]; promoCode: string | null;
}>;
export type PricingSourceRevisions = Readonly<{
  pms: string; terms: string; promotions: string; addons: string; charges: string; finance: string; fx: string;
}>;
type Window = Readonly<{ from: string; through: string }> | null;
type Discount = Readonly<{ kind: "percentage"; basisPoints: number }> | Readonly<{ kind: "fixed"; amountMinor: string }>;
export type ReplacementPromotionPolicy = Readonly<{
  hotelLastMinute: { enabled: boolean; tiers: readonly { throughDaysBeforeArrival: number; discount: Discount }[] };
  roomLastMinute: readonly { roomTypeId: string; policy: { kind: "inherit" } | { kind: "disabled" } |
    { kind: "override"; tiers: readonly { throughDaysBeforeArrival: number; discount: Discount }[] } }[];
  codes: readonly { id: string; code: string; discount: Discount; bookingWindow: Window; arrivalWindow: Window;
    minNights: number; maxUses: number | null; uses: number; roomTypeIds: readonly string[] | null }[];
  stacking: boolean;
}>;
export type ReplacementOfferTerms = Readonly<{
  roomTypeId: string; offerId: string; revision: string;
  cancellation: { kind: "non_refundable" } | { kind: "flexible"; freeUntilDaysBeforeArrival: number;
    latePenalty: { kind: "percentage"; basisPoints: number } | { kind: "first_nights"; nights: number } };
  payment: { kind: "full" } | { kind: "deposit"; basisPoints: number; balanceDaysBeforeArrival: number };
}>;
export type ReplacementAddon = Readonly<{ id: string; amountMinor: string;
  unit: "booking" | "night" | "person" | "person_night"; childBandAmountsMinor: readonly string[] | null }>;
export type ReplacementCharge = Readonly<{ id: string; amountMinor: string; included: boolean;
  collect: "online" | "property"; basisEvidenceId: string }>;
export type ReplacementFx = Readonly<{ id: string; from: string; to: string;
  numerator: string; denominator: string; observedAt: string; expiresAt: string }>;
/** Owners return validated, same-snapshot data. This is not an HTTP payload. */
export type ReplacementPricingOwnerInputs = Readonly<{
  revisions: PricingSourceRevisions; propertyTimeZone: string; bookingLocalDate: string;
  configurations: readonly PricingConfiguration[]; terms: readonly ReplacementOfferTerms[];
  promotions: ReplacementPromotionPolicy; addons: readonly ReplacementAddon[];
  charges: readonly ReplacementCharge[]; fx: readonly ReplacementFx[];
  paymentCapabilityEvidenceId: string; mandatoryChargeEvidenceId: string;
}>;
export interface ReplacementPricingOwnerPort {
  read(stay: ReplacementStay): Promise<ReplacementPricingOwnerInputs | { unavailable: string }>;
}
export type ReplacementPricingLine = Readonly<{ id: string; selectionId: string | null;
  kind: "room" | "meal" | "addon" | "charge" | "discount"; amountMinor: string }>;
export type ReplacementPricingEvidence = Readonly<{
  version: "pricing.v2"; requestKey: string; revisions: PricingSourceRevisions; currency: string;
  issuedAt: string; expiresAt: string; lines: readonly ReplacementPricingLine[];
  totalMinor: string; dueNowMinor: string; dueLaterMinor: string;
  terms: readonly ReplacementOfferTerms[]; fx: readonly ReplacementFx[];
  paymentCapabilityEvidenceId: string; mandatoryChargeEvidenceId: string;
}>;
export type ReplacementPricingResult = { kind: "priced"; evidence: ReplacementPricingEvidence } |
  { kind: "unavailable"; reason: "missing_price" | "invalid_guests" | "restriction" | "missing_owner_evidence" |
    "unsupported_currency" | "overflow" | "stale" };

const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v === v.trim();
function validTerms(t: ReplacementOfferTerms): boolean {
  const c = t.cancellation, p = t.payment;
  return nonempty(t.roomTypeId) && nonempty(t.offerId) && nonempty(t.revision) &&
    (c.kind === "non_refundable" || (c.kind === "flexible" && pricingInteger(c.freeUntilDaysBeforeArrival) &&
      (c.latePenalty.kind === "percentage" ? pricingInteger(c.latePenalty.basisPoints) && c.latePenalty.basisPoints <= 10000 :
        c.latePenalty.kind === "first_nights" && pricingInteger(c.latePenalty.nights, 1)))) &&
    (p.kind === "full" || (p.kind === "deposit" && pricingInteger(p.basisPoints, 1) && p.basisPoints <= 10000 && pricingInteger(p.balanceDaysBeforeArrival)));
}
function validFx(f: ReplacementFx, now: number): boolean {
  return nonempty(f.id) && pricingCurrencyScale(f.from) !== null && pricingCurrencyScale(f.to) !== null && f.from !== f.to &&
    isPositiveMinor(f.numerator) && isPositiveMinor(f.denominator) &&
    Date.parse(f.observedAt) <= now && Date.parse(f.expiresAt) > now;
}
/** Public stay boundary: owner adapters still verify tenant scope and guest capacity. */
export function parseReplacementStay(value: unknown): ReplacementStay | null {
  if (!pricingObject(value) || !pricingKeys(value, ["propertyId", "checkIn", "checkOut", "currency", "rooms", "addons", "promoCode"]) ||
      !nonempty(value.propertyId) || !pricingDate(value.checkIn) || !pricingDate(value.checkOut) || value.checkOut <= value.checkIn ||
      typeof value.currency !== "string" || pricingCurrencyScale(value.currency) === null ||
      !(value.promoCode === null || nonempty(value.promoCode)) || !Array.isArray(value.rooms) || !value.rooms.length || !Array.isArray(value.addons)) return null;
  for (const r of Array.from(value.rooms)) {
    if (!pricingObject(r) || !pricingKeys(r, ["selectionId", "roomTypeId", "offerId", "guests"]) ||
        ![r.selectionId, r.roomTypeId, r.offerId].every(nonempty) || !pricingObject(r.guests) ||
        !pricingKeys(r.guests, ["adults", "childAgesAtCheckIn"]) || !pricingInteger(r.guests.adults, 1) ||
        !Array.isArray(r.guests.childAgesAtCheckIn) || !Array.from(r.guests.childAgesAtCheckIn).every((age) => pricingInteger(age) && age <= 17)) return null;
  }
  for (const a of Array.from(value.addons)) if (!pricingObject(a) || !pricingKeys(a, ["id", "quantity"]) || !nonempty(a.id) || !pricingInteger(a.quantity, 1)) return null;
  if (new Set(value.rooms.map((r) => r.selectionId)).size !== value.rooms.length || new Set(value.addons.map((a) => a.id)).size !== value.addons.length) return null;
  return structuredClone(value) as ReplacementStay;
}
/** Deterministic only for parsed stays; caller-supplied hashes never establish trust. */
export function replacementStayKey(stay: ReplacementStay): string {
  return createHash("sha256").update(JSON.stringify([stay.propertyId, stay.checkIn, stay.checkOut, stay.currency,
    stay.rooms.map((r) => [r.selectionId, r.roomTypeId, r.offerId, r.guests.adults, [...r.guests.childAgesAtCheckIn].sort((a, b) => a - b)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    stay.addons.map((a) => [a.id, a.quantity]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), stay.promoCode])).digest("hex");
}
/** Arithmetic/staleness check on trusted evaluator output, NOT client quote authorization. */
export function replacementEvidenceStatus(e: ReplacementPricingEvidence, stay: ReplacementStay,
  current: PricingSourceRevisions, now: Date): "current" | "stale" | "invalid" {
  const start = Date.parse(e.issuedAt), end = Date.parse(e.expiresAt), time = now.getTime();
  if (e.version !== "pricing.v2" || e.currency !== stay.currency || ![start, end, time].every(Number.isFinite) || end <= start ||
      ![e.totalMinor, e.dueNowMinor, e.dueLaterMinor].every(isMinorAmount) || !e.lines.length ||
      !nonempty(e.paymentCapabilityEvidenceId) || !nonempty(e.mandatoryChargeEvidenceId)) return "invalid";
  const offerKey = (r: { roomTypeId: string; offerId: string }) => JSON.stringify([r.roomTypeId, r.offerId]);
  const offers = new Set(stay.rooms.map(offerKey));
  if (e.terms.length !== offers.size || new Set(e.terms.map(offerKey)).size !== offers.size ||
      e.terms.some((t) => !offers.has(offerKey(t)) || !validTerms(t)) || e.fx.some((f) => !validFx(f, time))) return "invalid";
  const selections = new Set(stay.rooms.map((r) => r.selectionId));
  const ids = new Set<string>(); let total = 0n;
  for (const line of e.lines) {
    if (!nonempty(line.id) || ids.has(line.id) || !isMinorAmount(line.amountMinor) ||
        !["room", "meal", "addon", "charge", "discount"].includes(line.kind) ||
        (line.selectionId !== null && !selections.has(line.selectionId)) ||
        (["room", "meal"].includes(line.kind) && line.selectionId === null)) return "invalid";
    ids.add(line.id); total += BigInt(line.amountMinor) * (line.kind === "discount" ? -1n : 1n);
  }
  if ([...selections].some((id) => !e.lines.some((l) => l.kind === "room" && l.selectionId === id && isPositiveMinor(l.amountMinor))) ||
      total <= 0n || total !== BigInt(e.totalMinor) || BigInt(e.dueNowMinor) + BigInt(e.dueLaterMinor) !== total) return "invalid";
  if (e.requestKey !== replacementStayKey(stay) || time < start || time >= end ||
      ["pms", "terms", "promotions", "addons", "charges", "finance", "fx"].some((key) =>
        !nonempty(current[key as keyof PricingSourceRevisions]) || e.revisions[key as keyof PricingSourceRevisions] !== current[key as keyof PricingSourceRevisions])) return "stale";
  return "current";
}
