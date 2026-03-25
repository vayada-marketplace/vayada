import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getCurrencySymbol(currency: string): string {
  const symbols: Record<string, string> = {
    USD: '$', EUR: '\u20AC', GBP: '\u00A3', JPY: '\u00A5', CNY: '\u00A5',
    KRW: '\u20A9', INR: '\u20B9', THB: '\u0E3F', IDR: 'Rp', MYR: 'RM',
    PHP: '\u20B1', VND: '\u20AB', SGD: 'S$', AUD: 'A$', NZD: 'NZ$',
    CAD: 'C$', CHF: 'CHF', SEK: 'kr', NOK: 'kr', DKK: 'kr',
    HKD: 'HK$', TWD: 'NT$', ZAR: 'R', BRL: 'R$', MXN: 'MX$',
    AED: 'AED', SAR: 'SAR', TRY: '\u20BA', PLN: 'z\u0142', CZK: 'K\u010D',
    HUF: 'Ft', RON: 'lei', HRK: 'kn', RUB: '\u20BD', ILS: '\u20AA',
    EGP: 'E\u00A3', MAD: 'MAD', KES: 'KSh', NGN: '\u20A6', GHS: 'GH\u20B5',
    COP: 'COL$', PEN: 'S/.', CLP: 'CLP$', ARS: 'ARS$',
  }
  return symbols[currency] || currency
}
