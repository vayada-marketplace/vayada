import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getCurrencySymbol(currency: string): string {
  const symbols: Record<string, string> = {
    USD: 'US$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥',
    KRW: '₩', INR: '₹', THB: '฿', IDR: 'Rp', MYR: 'RM',
    PHP: '₱', VND: '₫', SGD: 'S$', AUD: 'A$', NZD: 'NZ$',
    CAD: 'C$', CHF: 'CHF', SEK: 'kr', NOK: 'kr', DKK: 'kr',
    HKD: 'HK$', TWD: 'NT$', ZAR: 'R', BRL: 'R$', MXN: 'MX$',
    AED: 'AED', SAR: 'SAR', TRY: '₺', PLN: 'zł', CZK: 'Kč',
    HUF: 'Ft', RON: 'lei', HRK: 'kn', RUB: '₽', ILS: '₪',
    EGP: 'E£', MAD: 'MAD', KES: 'KSh', NGN: '₦', GHS: 'GH₵',
    COP: 'COL$', PEN: 'S/.', CLP: 'CLP$', ARS: 'ARS$',
  }
  return symbols[currency] || currency
}

export function formatCurrency(amount: number, currency: string): string {
  const symbol = getCurrencySymbol(currency)
  return `${symbol}${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}
