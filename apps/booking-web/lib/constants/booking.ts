import { Addon } from '@/lib/types'

/** Fallback multiplier for non-refundable pricing (15% discount) — only used if server doesn't provide a rate */
export const NON_REFUNDABLE_DISCOUNT = 0.85

export function getNonRefundableRate(baseRate: number, nonRefundableRate?: number | null): number {
  return nonRefundableRate ?? Math.round(baseRate * NON_REFUNDABLE_DISCOUNT * 100) / 100
}

/** Parse the admin-selected cancellation policy string (e.g. "Free until 14 days before")
 *  into the number of days before check-in. Falls back to 7 if the policy string is missing
 *  or in an unexpected format. */
export function getFreeCancellationDays(cancellationPolicy?: string | null): number {
  if (!cancellationPolicy) return 7
  const match = cancellationPolicy.match(/(\d+)\s*days?/i)
  return match ? parseInt(match[1], 10) : 7
}

/** Today's date as YYYY-MM-DD in the given IANA timezone (falls back to browser local). */
function todayInTimezone(timezone?: string | null): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(new Date())
}

/** Whole days between two YYYY-MM-DD date strings (b - a). */
function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime()
  const db = new Date(`${b}T00:00:00Z`).getTime()
  return Math.round((db - da) / 86_400_000)
}

/** Smallest "days before check-in" window after which Flexible Rate cancellation is no longer
 *  meaningful. For free-cancellation rates this is the policy's days-before-checkin. For
 *  partial-refund rates, Flexible only fully expires once even the lowest tier window has
 *  passed, so we use the smallest minDaysBeforeCheckIn. */
export function getFlexibleCancellationCutoffDays(room: {
  cancellationPolicy?: string | null
  flexibleCancellationType?: 'free' | 'partial_refund'
  partialRefundCancelWindowDays?: number | null
  partialRefundTiers?: { minDaysBeforeCheckIn: number; refundPercent: number }[] | null
}): number {
  if (room.flexibleCancellationType === 'partial_refund') {
    if (room.partialRefundTiers && room.partialRefundTiers.length > 0) {
      return Math.min(...room.partialRefundTiers.map((t) => t.minDaysBeforeCheckIn))
    }
    return room.partialRefundCancelWindowDays ?? 30
  }
  return getFreeCancellationDays(room.cancellationPolicy)
}

/** True when the Flexible Rate cancellation deadline has already passed for the given check-in.
 *  Boundary day (daysUntilCheckIn === cutoff) is treated as still-allowed; one day later it
 *  expires. Comparison uses the property's local "today" so a guest in another timezone sees
 *  the same eligibility as the hotel. */
export function isFlexibleCancellationExpired(
  checkIn: string,
  room: Parameters<typeof getFlexibleCancellationCutoffDays>[0],
  timezone?: string | null,
): boolean {
  if (!checkIn) return false
  const cutoff = getFlexibleCancellationCutoffDays(room)
  const daysUntil = daysBetween(todayInTimezone(timezone), checkIn)
  return daysUntil < cutoff
}

/** Calculate the discount amount from a promo code. */
export function calculatePromoDiscount(
  subtotal: number,
  discountType: string,
  discountValue: number,
): number {
  if (discountType === 'percentage') {
    return Math.round(subtotal * (discountValue / 100) * 100) / 100
  }
  return Math.min(discountValue, subtotal)
}

/** Calculate the total price for selected addons, accounting for perNight and quantity.
 *  qty is the user's "+/-" stepper value: nights for perNight addons, people for perPerson
 *  addons. Either way price = addon.price * qty — never multiply by room occupancy. */
export function calculateAddonTotal(
  addons: Addon[],
  selectedIds: string[],
  nights: number,
  quantities?: Record<string, number>,
): number {
  let total = 0
  for (const addon of addons) {
    if (!selectedIds.includes(addon.id)) continue
    const qty = addon.perNight
      ? (quantities?.[addon.id] ?? nights)
      : (quantities?.[addon.id] ?? 1)
    total += addon.price * qty
  }
  return Math.round(total * 100) / 100
}
