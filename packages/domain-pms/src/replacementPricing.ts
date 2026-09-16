/** New contracts only; no old pricing fallback or live calculation entry point. */
export const REPLACEMENT_PRICING_VERSION = "pricing.v2" as const;
export type PricingMoney = Readonly<{ currency: string; amountMinor: string }>;
export type PricingAdjustment =
  | Readonly<{ kind: "fixed"; deltaMinor: string }>
  | Readonly<{ kind: "percentage"; basisPoints: number }>;
export type RoomPrice =
  | Readonly<{ mode: "flat"; amountMinor: string }>
  | Readonly<{ mode: "occupancy"; amountsMinor: readonly string[] }>
  | Readonly<{
      mode: "included_guests";
      baseGuests: number;
      baseMinor: string;
      adjustments: readonly PricingAdjustment[];
    }>
  | Readonly<{ mode: "per_person"; unitMinor: string }>;

// ICU supplies the currency vocabulary, but its display defaults differ from ISO minor units.
// SIX List One (2026-01-01): these are the differences from Node 24/26 ICU.
// https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
const accountingScales: Readonly<Record<string, number>> = Object.freeze({
  AFN: 2, ALL: 2, COP: 2, HUF: 2, IDR: 2, IQD: 3, IRR: 2, KPW: 2,
  LAK: 2, LBP: 2, MGA: 2, MMK: 2, PKR: 2, SOS: 2, SYP: 2, YER: 2,
});
const currencies = new Set(Intl.supportedValuesOf("currency"));
export function pricingCurrencyScale(currency: string): number | null {
  if (!currencies.has(currency)) return null;
  return accountingScales[currency] ?? new Intl.NumberFormat("en", { style: "currency", currency })
    .resolvedOptions().maximumFractionDigits ?? null;
}
export function isMinorAmount(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && /^(0|[1-9][0-9]{0,17})$/.test(value);
}
export function isPositiveMinor(value: unknown): value is string {
  return isMinorAmount(value) && value !== "0";
}
export function pricingObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function pricingKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function pricingInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
export function parsePricingMoney(value: unknown): PricingMoney | null {
  if (!pricingObject(value) || !pricingKeys(value, ["currency", "amountMinor"])) return null;
  if (typeof value.currency !== "string" || pricingCurrencyScale(value.currency) === null ||
      !isMinorAmount(value.amountMinor)) return null;
  return Object.freeze({ currency: value.currency, amountMinor: value.amountMinor });
}
export function parsePricingAdjustment(value: unknown): PricingAdjustment | null {
  if (!pricingObject(value)) return null;
  if (value.kind === "fixed" && pricingKeys(value, ["kind", "deltaMinor"]) &&
      typeof value.deltaMinor === "string" && value.deltaMinor.trim() === value.deltaMinor && /^(0|-?[1-9][0-9]{0,17})$/.test(value.deltaMinor)) {
    return Object.freeze({ kind: "fixed", deltaMinor: value.deltaMinor });
  }
  if (value.kind === "percentage" && pricingKeys(value, ["kind", "basisPoints"]) &&
      pricingInteger(value.basisPoints, -10000)) {
    return Object.freeze({ kind: "percentage", basisPoints: value.basisPoints });
  }
  return null;
}
/** Arrays are ordered by adult-equivalent occupancy 1..capacity; no sparse fallback. */
export function parseRoomPrice(value: unknown, adultCapacity: number): RoomPrice | null {
  if (!pricingInteger(adultCapacity, 1) || !pricingObject(value)) return null;
  if (value.mode === "flat" && pricingKeys(value, ["mode", "amountMinor"]) &&
      isPositiveMinor(value.amountMinor)) {
    return Object.freeze({ mode: "flat", amountMinor: value.amountMinor });
  }
  if (value.mode === "per_person" && pricingKeys(value, ["mode", "unitMinor"]) &&
      isPositiveMinor(value.unitMinor)) {
    return Object.freeze({ mode: "per_person", unitMinor: value.unitMinor });
  }
  if (value.mode === "occupancy" && pricingKeys(value, ["mode", "amountsMinor"]) &&
      Array.isArray(value.amountsMinor) && value.amountsMinor.length === adultCapacity &&
      Array.from(value.amountsMinor).every(isPositiveMinor)) {
    return Object.freeze({ mode: "occupancy", amountsMinor: Object.freeze([...value.amountsMinor]) });
  }
  if (value.mode !== "included_guests" ||
      !pricingKeys(value, ["mode", "baseGuests", "baseMinor", "adjustments"]) ||
      !pricingInteger(value.baseGuests, 1) || value.baseGuests > adultCapacity ||
      !isPositiveMinor(value.baseMinor) || !Array.isArray(value.adjustments) ||
      value.adjustments.length !== adultCapacity) return null;
  const adjustments = Array.from(value.adjustments, parsePricingAdjustment);
  if (adjustments.some((adjustment) => adjustment === null)) return null;
  const parsed = adjustments as PricingAdjustment[];
  const base = parsed[value.baseGuests - 1];
  if (base.kind !== "fixed" || base.deltaMinor !== "0") return null;
  // Every adjustment is relative to the base, not a cumulative extra-guest ladder.
  for (const adjustment of parsed) {
    if (adjustment.kind === "fixed" && BigInt(value.baseMinor) + BigInt(adjustment.deltaMinor) <= 0n) return null;
    if (adjustment.kind === "percentage" && adjustment.basisPoints === -10000) return null;
  }
  return Object.freeze({ mode: "included_guests", baseGuests: value.baseGuests,
    baseMinor: value.baseMinor, adjustments: Object.freeze(parsed) });
}
