const SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  JPY: "¥",
  THB: "฿",
  PHP: "₱",
  IDR: "IDR ",
  CHF: "CHF",
  AUD: "A$",
  SGD: "S$",
};

/** `locale` sets the digit grouping (the PMS language's, e.g. "de" → 1.167.958); none follows the browser. */
export function formatCurrency(
  amount: number,
  currency: string,
  fractionDigits = 0,
  locale?: string,
): string {
  const symbol = SYMBOLS[currency] || currency + " ";
  return `${symbol}${amount.toLocaleString(locale, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
}
