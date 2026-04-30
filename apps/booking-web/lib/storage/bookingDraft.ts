import { Booking } from '@/lib/types'

/**
 * Centralizes the sessionStorage keys the checkout flow uses, so we read and
 * write the same shape from every page and any future migration (e.g. to a
 * BookingDraftContext keyed by a URL ?draft= token, which would also let
 * deep-link reloads survive a browser restart) only has to touch this module.
 */

export interface GuestDetailsDraft {
  roomTypeId: string
  guestFirstName: string
  guestLastName: string
  guestEmail: string
  guestPhone: string
  guestCountry?: string
  specialRequests?: string
  estimatedArrivalTime?: string
  numberOfGuests?: number
  referralCode?: string
  addonIds?: string[]
  addonQuantities?: Record<string, number>
}

const GUEST_KEY = 'guestDetails'
const LAST_BOOKING_KEY = 'lastBooking'

function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null
  try { return sessionStorage.getItem(key) } catch { return null }
}

function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try { sessionStorage.setItem(key, value) } catch {}
}

export function saveGuestDetails(draft: GuestDetailsDraft): void {
  safeSet(GUEST_KEY, JSON.stringify(draft))
}

export function readGuestDetails(): GuestDetailsDraft | null {
  const raw = safeGet(GUEST_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) as GuestDetailsDraft } catch { return null }
}

export function saveLastBooking(booking: Booking | (Partial<Booking> & { bookingReference: string })): void {
  safeSet(LAST_BOOKING_KEY, JSON.stringify(booking))
}

export function readLastBooking(): Booking | null {
  const raw = safeGet(LAST_BOOKING_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) as Booking } catch { return null }
}
