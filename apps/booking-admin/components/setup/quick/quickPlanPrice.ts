import { fixedPlanAmountMinor, stripeCurrencyHasZeroDecimals } from "@vayada/domain-finance";

export type QuickFixedFeePrice =
  | Readonly<{ available: true; base: string; extraRoom: string }>
  | Readonly<{ available: false }>;

function money(minor: number, currency: string): string {
  const divisor = stripeCurrencyHasZeroDecimals(currency) ? 1 : 100;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(minor / divisor);
}

/**
 * VAY-2247 "Your vayada plan": the Fixed Fee in the hotel's currency, from the same catalogue the
 * finance service bills with ("€30 / month: €30 for the first active room + €5 for each additional
 * room"), or the currency it isn't offered in yet.
 */
export function quickFixedFeePrice(currency: string): QuickFixedFeePrice {
  try {
    const base = fixedPlanAmountMinor(1, currency);
    const extraRoom = fixedPlanAmountMinor(2, currency) - base;
    return Object.freeze({
      available: true,
      base: money(base, currency),
      extraRoom: money(extraRoom, currency),
    });
  } catch {
    return Object.freeze({ available: false });
  }
}
