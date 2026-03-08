/** Multiplier applied to base rate for non-refundable pricing (15% discount) */
export const NON_REFUNDABLE_DISCOUNT = 0.85

export function getNonRefundableRate(baseRate: number, nonRefundableRate?: number | null): number {
  return nonRefundableRate ?? Math.round(baseRate * NON_REFUNDABLE_DISCOUNT)
}
