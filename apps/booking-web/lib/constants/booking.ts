import { Addon } from '@/lib/types'

/** Fallback multiplier for non-refundable pricing (15% discount) — only used if server doesn't provide a rate */
export const NON_REFUNDABLE_DISCOUNT = 0.85

export function getNonRefundableRate(baseRate: number, nonRefundableRate?: number | null): number {
  return nonRefundableRate ?? Math.round(baseRate * NON_REFUNDABLE_DISCOUNT * 100) / 100
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

/** Calculate the total price for selected addons, accounting for perPerson, perNight, and quantity.
 *  For perNight addons, qty represents the number of nights selected (not a generic multiplier). */
export function calculateAddonTotal(
  addons: Addon[],
  selectedIds: string[],
  adults: number,
  nights: number,
  quantities?: Record<string, number>,
): number {
  let total = 0
  for (const addon of addons) {
    if (!selectedIds.includes(addon.id)) continue
    // For perNight addons, qty = number of nights selected; default to all nights
    const qty = addon.perNight
      ? (quantities?.[addon.id] ?? nights)
      : (quantities?.[addon.id] ?? 1)
    let price = addon.price
    if (addon.perPerson) price *= adults
    // qty already represents nights for perNight addons, so just multiply by qty
    price *= qty
    total += price
  }
  return Math.round(total * 100) / 100
}
