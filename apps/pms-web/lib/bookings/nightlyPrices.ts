import { pricingAmountStep, pricingCurrencyScale } from "@vayada/domain-pms/replacement-pricing";

/** One night of a booking at its booked room price: all its rooms added up (VAY-2576). */
export type BookedNight = { date: string; amount: number };

export type NightlyPriceSummary = {
  currency: string;
  /** Booked price per night: the nights' average, or the booking value over its nights without them. */
  average: number;
  /** Each night's booked price, or null when a night has none (the popover then shows the average only). */
  nights: BookedNight[] | null;
  /** What the booking value holds besides the nights (OTA fees or taxes, extras); null when nothing. */
  feesAndExtras: number | null;
  /** The booking value, which the nights and the fees add up to. */
  total: number;
};

/** The decimals a currency's prices show: none for whole-unit currencies (IDR, JPY). */
function displayScale(currency: string): number {
  const scale = pricingCurrencyScale(currency) ?? 2;
  return scale === 0 || pricingAmountStep(currency) === 10 ** scale ? 0 : scale;
}

/** The decimals to show these amounts with: the currency's, or none when every one is whole. */
export function priceDigits(currency: string, ...amounts: number[]): number {
  const unit = 10 ** displayScale(currency);
  return amounts.every((amount) => Math.round(amount * unit) % unit === 0)
    ? 0
    : displayScale(currency);
}

/**
 * The popover's "Price per night" (VAY-2576). With a booked price for every night, each night shows at the currency's
 * precision and whatever else the booking value holds (OTA fees or taxes, extras) becomes "Fees and extras", so the
 * rows add up to the booking value; the average is the nights'. A difference of up to one cent a night is the
 * per-night amounts' rounding, so the last night takes it. Without a price for every night, or when the nights come
 * to more than the booking value, only the booking value's average over its nights is shown.
 */
export function nightlyPriceSummary(
  value: { amount: number; currency: string } | null,
  stayNights: number,
  booked: readonly BookedNight[] | null | undefined,
): NightlyPriceSummary | null {
  if (!value || !Number.isFinite(value.amount) || stayNights < 1) return null;
  const { amount: total, currency } = value;
  const unit = 10 ** displayScale(currency);
  const averageOnly: NightlyPriceSummary = {
    currency,
    average: total / stayNights,
    nights: null,
    feesAndExtras: null,
    total,
  };
  if (!booked?.length || booked.some((night) => !Number.isFinite(night.amount))) return averageOnly;

  const rows = booked.map((night) => Math.round(night.amount * unit));
  const sum = () => rows.reduce((units, row) => units + row, 0);
  let feesUnits = Math.round(total * unit) - sum();
  if (Math.abs(feesUnits) <= rows.length) {
    const last = rows.length - 1;
    rows[last] = (rows[last] ?? 0) + feesUnits;
    feesUnits = 0;
  }
  if (feesUnits < 0) return averageOnly;
  return {
    currency,
    average: sum() / unit / rows.length,
    nights: booked.map((night, index) => ({ date: night.date, amount: (rows[index] ?? 0) / unit })),
    feesAndExtras: feesUnits > 0 ? feesUnits / unit : null,
    total,
  };
}
