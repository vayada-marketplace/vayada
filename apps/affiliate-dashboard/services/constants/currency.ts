/**
 * Currency symbol lookup for short, glanceable formatting (chart labels,
 * stat cards). For full localized formatting prefer Intl.NumberFormat
 * with style: 'currency'.
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  IDR: 'Rp',
}

export function currencySymbol(currencyCode: string): string {
  return CURRENCY_SYMBOLS[currencyCode] || `${currencyCode} `
}
