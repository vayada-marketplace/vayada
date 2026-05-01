import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const LOCALE_MAP: Record<string, string> = {
  en: 'en-GB',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  id: 'id-ID',
}

function resolveLocale(locale?: string): string {
  return LOCALE_MAP[locale || 'en'] || 'en-GB'
}

export function formatCurrency(amount: number, currency: string = 'EUR'): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export function formatDate(date: string | Date, locale?: string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString(resolveLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDateShort(date: string | Date, locale?: string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString(resolveLocale(locale), {
    day: 'numeric',
    month: 'short',
  })
}

export function calculateNights(checkIn: string, checkOut: string): number {
  const start = new Date(checkIn)
  const end = new Date(checkOut)
  const diff = end.getTime() - start.getTime()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

// Parsed as local date so DST / timezone doesn't shift the result.
function addOneLocalDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return ''
  const next = new Date(y, m - 1, d + 1)
  const yyyy = next.getFullYear()
  const mm = String(next.getMonth() + 1).padStart(2, '0')
  const dd = String(next.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// Guarantees at least one night between check-in and check-out. If checkOut is
// missing, malformed, or not strictly after checkIn (e.g. a same-day URL like
// ?checkIn=2026-07-13&checkOut=2026-07-13), it is forced to checkIn + 1 day.
export function ensureMinOneNight(
  checkIn: string,
  checkOut: string,
): { checkIn: string; checkOut: string } {
  if (!checkIn) return { checkIn, checkOut }
  const advanced = addOneLocalDay(checkIn)
  if (!advanced) return { checkIn, checkOut }
  if (!checkOut || checkOut <= checkIn) return { checkIn, checkOut: advanced }
  return { checkIn, checkOut }
}

export function generateBookingReference(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = 'VBK-'
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}
