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

export function formatCurrency(amount: number, currency: string, fractionDigits = 0): string {
  const symbol = SYMBOLS[currency] || currency + " ";
  return `${symbol}${amount.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
}
