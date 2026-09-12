import { pricingCurrencyScale, pricingInteger, pricingKeys, pricingObject, type PricingAdjustment, type RoomPrice } from "./replacementPricing.js";
import { parsePricingConfiguration, type PricingCalendar, type PricingConfiguration } from "./replacementPricingConfiguration.js";

/** Structural match for Booking's ReplacementFx. Ratio includes both currency scales.
 * A trusted FX owner must establish provenance; this module validates arithmetic only. */
export type PricingConversionRate = Readonly<{ id: string; from: string; to: string;
  numerator: string; denominator: string; observedAt: string; expiresAt: string }>;
const positive = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,17}$/.test(v);
const timestamp = (v: unknown): number => {
  if (typeof v !== "string") return NaN;
  const time = Date.parse(v);
  return Number.isFinite(time) && new Date(time).toISOString() === v ? time : NaN;
};
function validRate(rate: unknown, now: number): rate is PricingConversionRate {
  if (!pricingObject(rate) || !pricingKeys(rate, ["id", "from", "to", "numerator", "denominator", "observedAt", "expiresAt"]) ||
      typeof rate.id !== "string" || !rate.id.length || rate.id.length > 200 || rate.id.trim() !== rate.id ||
      typeof rate.from !== "string" || typeof rate.to !== "string" || rate.from === rate.to ||
      pricingCurrencyScale(rate.from) === null || pricingCurrencyScale(rate.to) === null ||
      !positive(rate.numerator) || !positive(rate.denominator) || !pricingInteger(now)) return false;
  return timestamp(rate.observedAt) <= now && now < timestamp(rate.expiresAt);
}

/** Convert every PMS-owned component. Failure returns no partial configuration. */
export function convertPricingConfigurationCurrency(value: unknown, rate: unknown, now: number): PricingConfiguration | null {
  const source = parsePricingConfiguration(value);
  if (!source || !validRate(rate, now) || source.currency !== rate.from || !pricingInteger(source.revision + 1, 1)) return null;
  const numerator = BigInt(rate.numerator), denominator = BigInt(rate.denominator);
  let lostPositiveTariff = false;
  const amount = (text: string, signedAdjustment = false): string => {
    const value = BigInt(text), magnitude = (value < 0n ? -value : value) * numerator;
    const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
    if (!signedAdjustment && value > 0n && rounded === 0n) lostPositiveTariff = true;
    return (value < 0n ? -rounded : rounded).toString();
  };
  const adjustment = (a: PricingAdjustment): PricingAdjustment => a.kind === "percentage" ? a : { ...a, deltaMinor: amount(a.deltaMinor, true) };
  const price = (p: RoomPrice): RoomPrice => {
    switch (p.mode) {
      case "flat": return { ...p, amountMinor: amount(p.amountMinor) };
      case "per_person": return { ...p, unitMinor: amount(p.unitMinor) };
      case "occupancy": return { ...p, amountsMinor: p.amountsMinor.map((v) => amount(v)) };
      case "included_guests": return { ...p, baseMinor: amount(p.baseMinor), adjustments: p.adjustments.map(adjustment) };
    }
  };
  const dates = (items: PricingCalendar["dates"]) => items.map((d) => ({ ...d, price: price(d.price) }));
  const calendar = (c: PricingCalendar): PricingCalendar => ({
    base: c.base === null ? null : price(c.base),
    months: c.months.map((m) => ({ ...m, price: price(m.price) })),
    seasons: c.seasons.map((s) => ({ ...s, price: price(s.price) })),
    weekdays: c.weekdays.map((w) => ({ ...w, adjustment: adjustment(w.adjustment) })), dates: dates(c.dates),
  });
  const converted = { ...source, currency: rate.to, revision: source.revision + 1,
    children: { ...source.children, bands: source.children.bands.map((b) => ({ ...b, nightlyMinor: amount(b.nightlyMinor) })) },
    offers: source.offers.map((o) => ({ ...o,
      meal: { ...o.meal, charge: o.meal.charge.kind === "room" ? { ...o.meal.charge, amountMinor: amount(o.meal.charge.amountMinor) } :
        { ...o.meal.charge, adultMinor: amount(o.meal.charge.adultMinor), childBandAmountsMinor: o.meal.charge.childBandAmountsMinor.map((v) => amount(v)) } },
      price: o.price.kind === "independent" ? { ...o.price, calendar: calendar(o.price.calendar) } :
        { ...o.price, adjustment: adjustment(o.price.adjustment), dateOverrides: dates(o.price.dateOverrides) },
    })),
  };
  return lostPositiveTariff ? null : parsePricingConfiguration(converted);
}
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => pricingObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);

/** Complete PMS room set only. NOT sufficient for PricingStorageGuard.allowCurrencyChange:
 * caller must verify authoritative FX, property scope and all separately owned amounts. */
export function isCompletePricingCurrencyConversion(before: readonly unknown[], after: readonly unknown[], rate: unknown, now: number): boolean {
  if (!Array.isArray(before) || !Array.isArray(after) || !before.length || before.length !== after.length) return false;
  const old = Array.from(before, parsePricingConfiguration), next = Array.from(after, parsePricingConfiguration);
  if (old.some((r) => !r) || next.some((r) => !r)) return false;
  const reference = old[0]!;
  if (old.some((r) => r!.propertyId !== reference.propertyId || r!.revision !== reference.revision || r!.currency !== reference.currency) ||
      new Set(old.map((r) => r!.roomTypeId)).size !== old.length || new Set(next.map((r) => r!.roomTypeId)).size !== next.length) return false;
  return old.every((room) => {
    const converted = convertPricingConfigurationCurrency(room, rate, now);
    return converted !== null && canonical(converted) === canonical(next.find((r) => r!.roomTypeId === room!.roomTypeId));
  });
}
