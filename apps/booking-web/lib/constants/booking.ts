import { Addon } from '@/lib/types'

/** Multiplier applied to base rate for non-refundable pricing (15% discount) */
export const NON_REFUNDABLE_DISCOUNT = 0.85

export function getNonRefundableRate(baseRate: number, nonRefundableRate?: number | null): number {
  return nonRefundableRate ?? Math.round(baseRate * NON_REFUNDABLE_DISCOUNT)
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

/** Calculate the total price for selected addons, accounting for perPerson, perNight, and quantity. */
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
    const qty = quantities?.[addon.id] ?? 1
    let price = addon.price
    if (addon.perPerson) price *= adults
    if (addon.perNight) price *= nights
    price *= qty
    total += price
  }
  return Math.round(total * 100) / 100
}
