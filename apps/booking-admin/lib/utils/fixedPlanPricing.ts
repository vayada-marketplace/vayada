// What the Fixed Plan costs per currency: a copy of FIXED_PLAN_PRICE_CATALOG in
// @vayada/domain-finance (subscriptions.ts), which is what Stripe charges. The billing card shows
// the plan's own currency from the API, never a hard-coded one (VAY-2201).
const FIXED_PLAN_UNIT_PRICES: Readonly<
  Record<string, { baseAmountMinor: number; extraUnitAmountMinor: number }>
> = {
  EUR: { baseAmountMinor: 3_000, extraUnitAmountMinor: 500 },
  USD: { baseAmountMinor: 3_000, extraUnitAmountMinor: 500 },
  IDR: { baseAmountMinor: 50_000_000, extraUnitAmountMinor: 8_000_000 },
};

export function fixedPlanUnitPrices(currency: string) {
  return FIXED_PLAN_UNIT_PRICES[currency.trim().toUpperCase()] ?? null;
}

/** `whole` drops ".00" from round amounts, as in "$30 for the first active unit". */
export function formatBillingAmount(
  amountMinor: number,
  currency: string,
  locale: string,
  { whole = false }: { whole?: boolean } = {},
): string {
  const amount = amountMinor / 100;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    ...(whole && Number.isInteger(amount)
      ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
      : {}),
  }).format(amount);
}
